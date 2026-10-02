"""Install the instrumentation and run real polars queries through it.

These exercise the whole path: polars resolving our factory by name, the
observer callbacks, sampling, model construction and export.
"""

from __future__ import annotations

import io

import pytest

pytestmark = pytest.mark.e2e

polars = pytest.importorskip("polars")

from opentelemetry import trace  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)

import polars_telemetry  # noqa: E402
from polars_telemetry import Config, SamplingMode  # noqa: E402
from polars_telemetry.export.console import ConsoleExporter  # noqa: E402
from polars_telemetry.export.otel import OTelExporter  # noqa: E402


@pytest.fixture(scope="module")
def spans():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    return exporter


def _query(pl, rows: int = 5_000):
    return (
        pl.DataFrame(
            {
                "customer": [i % 7 for i in range(rows)],
                "amount": [float(i % 31) for i in range(rows)],
            }
        )
        .lazy()
        .filter(pl.col("amount") > 3)
        .group_by("customer")
        .agg(pl.col("amount").sum())
        .sort("customer")
    )


def test_console_exporter_reports_a_real_query():
    stream = io.StringIO()
    state = polars_telemetry.install(
        Config(sampling=SamplingMode.FINAL, node_spans=False),
        exporter=ConsoleExporter(stream),
    )
    assert state is not None, "install() refused the installed polars"
    try:
        _query(polars).collect()
    finally:
        polars_telemetry.uninstall()

    output = stream.getvalue()
    assert "polars query" in output
    assert "GroupBy" in output
    assert "wall=" in output
    assert "cpu=" in output


def test_probe_reports_capabilities():
    state = polars_telemetry.install(exporter=ConsoleExporter(io.StringIO()))
    assert state is not None
    try:
        caps = state.capabilities
        assert caps.usable
        assert caps.node_metrics_usable, caps.problems
        assert caps.problems == ()
    finally:
        polars_telemetry.uninstall()


def test_install_is_idempotent():
    first = polars_telemetry.install(exporter=ConsoleExporter(io.StringIO()))
    second = polars_telemetry.install(exporter=ConsoleExporter(io.StringIO()))
    try:
        assert first is second
    finally:
        polars_telemetry.uninstall()


def test_uninstall_removes_the_injected_module():
    import sys

    polars_telemetry.install(exporter=ConsoleExporter(io.StringIO()))
    assert "polars_cloud" in sys.modules
    polars_telemetry.uninstall()
    assert "polars_cloud" not in sys.modules


def test_otel_query_span_and_node_spans(spans):
    spans.clear()
    config = Config(sampling=SamplingMode.INTERVAL, interval_ms=2, node_spans=True)
    state = polars_telemetry.install(config, exporter=OTelExporter(config))
    assert state is not None
    try:
        # Large enough that the sampler takes more than one snapshot; windows
        # need at least two.
        _query(polars, rows=3_000_000).collect()
    finally:
        polars_telemetry.uninstall()

    finished = spans.get_finished_spans()
    query_spans = [s for s in finished if s.name == "polars.collect"]
    assert len(query_spans) >= 1

    query_span = query_spans[-1]
    attrs = query_span.attributes
    assert attrs["polars.engine"] == "streaming"
    assert attrs["polars.cpu_ms"] > 0
    assert attrs["polars.node_count"] > 0
    assert attrs["polars.query_id"]
    assert attrs["polars.sample_resolution_ms"] == 2

    children = [
        s
        for s in finished
        if s.parent is not None and s.parent.span_id == query_span.context.span_id
    ]
    assert children, "no node spans were emitted"
    for child in children:
        assert child.attributes["polars.node.id"] is not None
        assert child.attributes["polars.sample_resolution_ms"] == 2
        assert child.start_time >= query_span.start_time
        assert child.end_time <= query_span.end_time


def test_node_spans_are_suppressed_without_sampling(spans):
    spans.clear()
    config = Config(sampling=SamplingMode.FINAL, node_spans=True)
    polars_telemetry.install(config, exporter=OTelExporter(config))
    try:
        _query(polars).collect()
    finally:
        polars_telemetry.uninstall()

    finished = spans.get_finished_spans()
    query_spans = [s for s in finished if s.name == "polars.collect"]
    assert query_spans
    children = [
        s
        for s in finished
        if s.parent is not None and s.parent.span_id == query_spans[-1].context.span_id
    ]
    assert children == [], "a single snapshot cannot produce honest node windows"
