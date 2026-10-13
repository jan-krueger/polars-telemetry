"""Every instrument the exporter declares must actually be recorded.

The registry, the attribute reference and its test all agreed on three
instruments that no code path ever recorded, so a dashboard built from the
documentation showed nothing.
"""

from __future__ import annotations

import dataclasses
from typing import Any
from uuid import uuid4

import pytest
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from polars_telemetry import Config
from polars_telemetry.adapter.build import build_plan
from polars_telemetry.export.measurements import COUNTERS, HISTOGRAMS
from polars_telemetry.export.otel import OTelExporter
from polars_telemetry.model.insights import Finding
from polars_telemetry.model.insights.finding import Impact
from polars_telemetry.model.types import NodeMetrics, Query


@pytest.fixture
def reader(monkeypatch):
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    monkeypatch.setattr(metrics, "get_meter", provider.get_meter)
    return reader


_FINDING = Finding(
    rule="in_memory_fallback",
    kind="problem",
    level="warn",
    node_id=0,
    node_kind="GroupBy",
    impact=Impact(cpu_share=1.0, blocked_share=0.5),
    title="t",
    fix="f",
    evidence=(),
)


def _busy_query() -> Query:
    """One node with every counter non-zero, so no instrument is skipped as empty."""
    fields: dict[str, Any] = {
        f.name: 7 for f in dataclasses.fields(NodeMetrics) if f.name != "custom"
    }
    fields.update(node_id=0, done=True, total_polls=10, total_stolen_polls=3)
    return Query(
        query_id=uuid4(),
        wall_ms=12.0,
        plan=build_plan([{"id": 0, "input_ids": [], "properties": {"type": "GroupBy"}}]),
        metrics={0: NodeMetrics(**fields)},
        insights=(_FINDING,),
        planning_ms=3.0,
        query_metrics={
            "io_total_active_ns": 2_000_000,
            "io_rx_active_ns": 2_000_000,
            "io_tx_active_ns": 0,
        },
    )


def _recorded(reader: InMemoryMetricReader) -> set[str]:
    data = reader.get_metrics_data()
    assert data is not None
    return {
        metric.name
        for resource in data.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
    }


def test_every_declared_instrument_is_recorded(reader):
    OTelExporter(Config()).export(_busy_query())

    declared = {name for name, _, _ in (*HISTOGRAMS, *COUNTERS)}
    assert declared - _recorded(reader) == set()
