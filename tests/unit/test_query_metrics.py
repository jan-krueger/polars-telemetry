"""Query-level counters, which polars sends next to the node rows from pola-rs/polars#29792."""

from __future__ import annotations

import io
import json
from typing import Any
from uuid import uuid4

import msgpack

from polars_telemetry.adapter.build import build_metrics, build_plan, enrich
from polars_telemetry.adapter.decode import decode_metrics, decode_snapshot
from polars_telemetry.adapter.handle import MetricsHandle
from polars_telemetry.adapter.profiles import read_profile
from polars_telemetry.export import semconv
from polars_telemetry.export.attributes import query_attributes
from polars_telemetry.export.console import ConsoleExporter
from polars_telemetry.export.measurements import measurements
from polars_telemetry.export.profile import build_profile
from polars_telemetry.model.types import COUNTER_NAMES, Query

QUERY = {
    "io_total_active_ns": 5_000_000,
    "io_rx_active_ns": 4_000_000,
    "io_tx_active_ns": 2_000_000,
    "num_threads": 12,
}


def _node() -> dict[str, Any]:
    return {**dict.fromkeys(COUNTER_NAMES, 0), "phys_node_key": 0, "done": True}


def _query(query_metrics: dict[str, int] | None) -> Query:
    return enrich(
        Query(
            query_id=uuid4(),
            wall_ms=10.0,
            plan=build_plan([{"id": 0, "input_ids": [], "properties": {"type": "InMemorySink"}}]),
            metrics=build_metrics([_node()]),
            query_metrics=query_metrics,
        )
    )


def test_both_snapshot_shapes_give_the_node_rows():
    rows = [_node()]
    assert decode_metrics(msgpack.packb(rows)) == rows
    assert decode_metrics(msgpack.packb({"query": QUERY, "nodes": rows})) == rows
    assert decode_snapshot(msgpack.packb(rows)) == (rows, None)
    assert decode_snapshot(msgpack.packb({"query": QUERY, "nodes": rows})) == (rows, QUERY)


def test_only_integer_query_counters_are_kept():
    payload = msgpack.packb({"query": {**QUERY, "flag": True, "name": "x"}, "nodes": []})
    assert decode_snapshot(payload)[1] == QUERY


class _Raw:
    def __init__(self, payload: Any) -> None:
        self.payload = payload

    def snapshot_query_metrics(self) -> bytes:
        return msgpack.packb(self.payload)


def test_the_handle_keeps_the_query_counters_of_its_last_snapshot():
    handle = MetricsHandle(_Raw({"query": QUERY, "nodes": [_node()]}))
    assert handle.settled_snapshot() == [_node()]
    assert handle.query == QUERY
    assert MetricsHandle(_Raw([_node()])).query is None


def test_profiles_carry_query_metrics_only_when_polars_sent_them():
    assert "query_metrics" not in build_profile(_query(None))
    document = json.loads(json.dumps(build_profile(_query(QUERY))))
    assert document["query_metrics"] == QUERY
    assert read_profile(document).query_metrics == QUERY


def test_span_attributes_name_each_counter():
    attrs = query_attributes(_query(QUERY))
    assert attrs[semconv.QUERY_METRICS_PREFIX + "io_total_active_ns"] == 5_000_000
    assert attrs[semconv.QUERY_METRICS_PREFIX + "num_threads"] == 12
    assert not any(
        k.startswith(semconv.QUERY_METRICS_PREFIX) for k in query_attributes(_query(None))
    )


def test_io_time_is_a_histogram_per_direction():
    query = _query(QUERY)
    assert query.diagnostics is not None
    io = {
        m.dims[semconv.DIRECTION]: m.value
        for m in measurements(query, query.diagnostics)
        if m.name == semconv.QUERY_IO_TIME
    }
    assert io == {"any": 5.0, "received": 4.0, "sent": 2.0}


def test_the_console_line_shows_io_time_when_sent():
    for query_metrics, shown in ((QUERY, True), (None, False)):
        out = io.StringIO()
        ConsoleExporter(stream=out).export(_query(query_metrics))
        assert ("io=" in out.getvalue()) is shown
