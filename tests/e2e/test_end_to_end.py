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
