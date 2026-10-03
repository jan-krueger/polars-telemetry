"""Install the instrumentation and run real polars queries through it.

These exercise the whole path: polars resolving our factory by name, the
observer callbacks, sampling, model construction and export.
"""

from __future__ import annotations

import io
from typing import Any

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
from polars_telemetry import Config  # noqa: E402
from polars_telemetry.export.base import Exporter  # noqa: E402
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
    state = polars_telemetry.install(Config(), exporter=ConsoleExporter(stream))
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


def test_otel_query_span_carries_plan_detail(spans):
    spans.clear()
    config = Config()
    state = polars_telemetry.install(config, exporter=OTelExporter(config))
    assert state is not None
    try:
        _query(polars, rows=200_000).collect()
    finally:
        polars_telemetry.uninstall()

    finished = spans.get_finished_spans()
    query_spans = [s for s in finished if s.name == "polars.collect"]
    assert len(query_spans) >= 1

    attrs = query_spans[-1].attributes
    assert attrs["polars.engine"] == "streaming"
    assert attrs["polars.cpu_ms"] > 0
    assert attrs["polars.node_count"] > 0
    assert attrs["polars.query_id"]
    assert attrs["polars.hot_node.kind"]
    assert 0 < attrs["polars.hot_node.share"] <= 1
    assert attrs["polars.groupby.count"] == 1


def test_no_child_spans_are_emitted(spans):
    """polars gives no per-node timestamps, so node spans would be invented."""
    spans.clear()
    config = Config()
    polars_telemetry.install(config, exporter=OTelExporter(config))
    try:
        _query(polars, rows=200_000).collect()
    finally:
        polars_telemetry.uninstall()

    finished = spans.get_finished_spans()
    query_span = [s for s in finished if s.name == "polars.collect"][-1]
    children = [
        s
        for s in finished
        if s.parent is not None and s.parent.span_id == query_span.context.span_id
    ]
    assert children == []


def test_node_metrics_can_be_disabled(spans):
    spans.clear()
    config = Config(node_metrics=False)
    polars_telemetry.install(config, exporter=OTelExporter(config))
    try:
        _query(polars).collect()
    finally:
        polars_telemetry.uninstall()

    attrs = [s for s in spans.get_finished_spans() if s.name == "polars.collect"][-1].attributes
    assert attrs["polars.node_count"] > 0
    assert "polars.cpu_ms" not in attrs


def test_eager_operations_do_not_disarm_the_observer():
    """Eager DataFrame work arrives with a nil physical plan.

    Treating that as a failure burned the error budget, and five eager
    operations silently disabled telemetry for the rest of the process.
    """
    collected = []

    class Collect(Exporter):
        def export(self, query):
            collected.append(query)

        def shutdown(self) -> None:
            pass

    state = polars_telemetry.install(exporter=Collect())
    assert state is not None
    try:
        frame = polars.DataFrame({"a": [1, 2, 3], "g": ["x", "x", "y"]})
        for multiplier in range(7):
            frame.with_columns(b=polars.col("a") * multiplier)

        assert len(collected) == 7, "eager operations were dropped"
        assert all(q.plan == {} for q in collected), "eager runs have no physical plan"
        assert all(q.logical for q in collected), "the IR plan is still available"

        collected.clear()
        _query(polars).collect()
        assert collected, "a lazy query after eager work was not instrumented"
        assert collected[-1].plan, "the lazy query lost its physical plan"
        assert collected[-1].metrics, "the lazy query lost its node counters"
    finally:
        polars_telemetry.uninstall()


def test_a_real_query_is_attributed_to_this_file():
    collected = []

    class Collect(Exporter):
        def export(self, query):
            collected.append(query)

        def shutdown(self) -> None:
            pass

    state = polars_telemetry.install(exporter=Collect())
    assert state is not None
    try:
        _query(polars).collect()
    finally:
        polars_telemetry.uninstall()

    site = collected[-1].call_site
    assert site is not None
    assert site.filepath == __file__
    assert site.function == "test_a_real_query_is_attributed_to_this_file"


def test_the_call_site_can_be_turned_off():
    collected = []

    class Collect(Exporter):
        def export(self, query):
            collected.append(query)

        def shutdown(self) -> None:
            pass

    state = polars_telemetry.install(Config(call_site=False), exporter=Collect())
    assert state is not None
    try:
        _query(polars).collect()
    finally:
        polars_telemetry.uninstall()

    assert collected[-1].call_site is None


def _collecting() -> tuple[list[Any], Exporter]:
    collected = []

    class Collect(Exporter):
        def export(self, query):
            collected.append(query)

        def shutdown(self) -> None:
            pass

    return collected, Collect()


def test_a_query_that_fails_before_planning_still_reports():
    """A missing column never reaches on_query_planned."""
    collected, exporter = _collecting()
    state = polars_telemetry.install(exporter=exporter)
    assert state is not None
    try:
        with pytest.raises(Exception, match="nope"):
            polars.LazyFrame({"a": [1]}).select(polars.col("nope")).collect()
    finally:
        polars_telemetry.uninstall()

    assert len(collected) == 1, "the failure produced no telemetry at all"
    query = collected[0]
    assert query.failed
    assert query.plan == {}, "nothing was planned, so there is no plan"
    assert query.wall_ms > 0


def test_the_failure_is_the_message_not_a_callback_repr():
    collected, exporter = _collecting()
    state = polars_telemetry.install(exporter=exporter)
    assert state is not None
    try:
        with pytest.raises(Exception, match="conversion"):
            polars.LazyFrame({"a": ["x"]}).select(polars.col("a").cast(polars.Int64)).collect()
    finally:
        polars_telemetry.uninstall()

    failed = collected[-1].failed
    assert failed is not None
    assert "conversion" in failed
    assert not failed.startswith("("), "a tuple repr leaks the callback signature"
    assert "UUID(" not in failed


def test_an_unreadable_ir_costs_only_the_ir(monkeypatch):
    """polars reshaping one payload must not take the counters or the span with it.

    Previously one shared guard dropped the node counters with the IR, and each
    query counted toward the disarm threshold, so five queries in, telemetry
    switched off entirely.
    """
    from polars_telemetry.adapter import observer

    def reshaped(payload: bytes) -> list[dict[str, object]]:
        raise ValueError("IR payload reshaped by a newer polars")

    monkeypatch.setattr(observer, "decode_plan", reshaped)

    collected, exporter = _collecting()
    state = polars_telemetry.install(exporter=exporter)
    assert state is not None
    try:
        for _ in range(8):
            _query(polars).collect()
    finally:
        polars_telemetry.uninstall()

    assert len(collected) == 8, "queries were dropped"
    assert all(q.logical == {} for q in collected), "the IR could not be read"
    assert all(q.plan for q in collected), "the physical plan was lost with the IR"
    assert all(q.metrics for q in collected), "the counters were lost with the IR"
