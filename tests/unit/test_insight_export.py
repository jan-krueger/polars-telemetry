from __future__ import annotations

import io
from dataclasses import replace
from uuid import uuid4

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from polars_telemetry import Config
from polars_telemetry.adapter.build import build_plan
from polars_telemetry.export import semconv
from polars_telemetry.export.console import ConsoleExporter
from polars_telemetry.export.measurements import measurements
from polars_telemetry.export.otel import OTelExporter
from polars_telemetry.model.diagnostics import Diagnostics
from polars_telemetry.model.insights import Finding
from polars_telemetry.model.insights.finding import Impact, Measure
from polars_telemetry.model.types import Query


def _finding(rule: str, level: str, kind: str = "problem") -> Finding:
    return Finding(
        rule=rule,
        kind=kind,  # type: ignore[arg-type]
        level=level,  # type: ignore[arg-type]
        node_id=0,
        node_kind="GroupBy",
        impact=Impact(cpu_share=0.25, blocked_share=0.123456),
        title=f"{rule} title",
        fix=f"{rule} fix",
        evidence=(Measure("rows_out", 12_400_000, "rows"), Measure("growth", 41.3, "ratio")),
    )


def _query(*findings: Finding) -> Query:
    return Query(
        query_id=uuid4(),
        wall_ms=12.0,
        plan=build_plan([{"id": 0, "input_ids": [], "properties": {"type": "GroupBy"}}]),
        engine="streaming",
        fingerprint="f00d",
        insights=findings,
    )


FOUND = (
    _finding("exploding_join", "warn"),
    _finding("cross_join", "info"),
    _finding("cross_join", "info"),
    _finding("file_skipping", "applied", kind="applied"),
)


def _span(query: Query):
    spans = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(spans))
    exporter = OTelExporter(Config())
    exporter._tracer = provider.get_tracer("test")
    exporter.export(query)
    (span,) = spans.get_finished_spans()
    return span


def test_each_finding_is_a_span_event():
    span = _span(_query(*FOUND))

    assert [e.name for e in span.events] == [semconv.INSIGHT_EVENT] * 4
    first = dict(span.events[0].attributes or {})
    assert first == {
        semconv.INSIGHT_RULE: "exploding_join",
        semconv.INSIGHT_LEVEL: "warn",
        semconv.NODE_KIND: "GroupBy",
        semconv.INSIGHT_TITLE: "exploding_join title",
        semconv.INSIGHT_FIX: "exploding_join fix",
        semconv.INSIGHT_EVIDENCE: "rows_out 12.4M · growth 41.3x",
        semconv.INSIGHT_CPU_SHARE: 0.25,
        semconv.INSIGHT_BLOCKED_SHARE: 0.1235,
    }
    assert span.attributes[semconv.INSIGHTS_WARNINGS] == 1


def test_a_query_without_insights_has_no_warning_count():
    span = _span(replace(_query(), insights=None))

    assert semconv.INSIGHTS_WARNINGS not in (span.attributes or {})
    assert span.events == ()


def test_problems_are_counted_by_rule_and_level():
    counted = {
        (m.dims[semconv.INSIGHT_RULE], m.dims[semconv.INSIGHT_LEVEL]): (m.value, m.dims)
        for m in measurements(_query(*FOUND), Diagnostics())
        if m.name == semconv.QUERY_INSIGHTS
    }

    assert set(counted) == {("exploding_join", "warn"), ("cross_join", "info")}
    value, dims = counted[("cross_join", "info")]
    assert value == 2
    assert set(dims) <= semconv.METRIC_DIMENSIONS
    assert dims[semconv.PLAN_FINGERPRINT] == "f00d"


def test_the_console_names_warnings_and_counts_the_rest():
    stream = io.StringIO()
    ConsoleExporter(stream).export(_query(*FOUND))
    text = stream.getvalue()

    assert "warn  exploding_join title  [exploding_join, GroupBy #0]" in text
    assert "rows_out 12.4M · growth 41.3x" in text
    assert "fix: exploding_join fix" in text
    assert "info  2 more" in text
    assert "cross_join title" not in text
    assert "file_skipping" not in text
