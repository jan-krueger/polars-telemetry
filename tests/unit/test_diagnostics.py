"""Derived diagnostics."""

from __future__ import annotations

import json
from uuid import uuid4

import pytest

from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.model.diagnostics import derive
from polars_telemetry.model.types import Query
from tests.fixture_paths import latest_fixture

FIXTURE = latest_fixture()


@pytest.fixture
def query():
    return Query(
        query_id=uuid4(),
        wall_ms=40.0,
        plan=build_plan(json.loads((FIXTURE / "physical.json").read_text())),
        logical=build_plan(json.loads((FIXTURE / "ir.json").read_text())),
        metrics=build_metrics(json.loads((FIXTURE / "metrics.json").read_text())),
    )


def test_parallel_efficiency_is_a_ratio(query):
    d = derive(query)
    assert d.parallel_efficiency is not None
    assert d.parallel_efficiency > 0
    assert d.cpu_count is not None
    assert d.cpu_count >= 1


def test_predicate_pushdown_is_detected(query):
    """The capture query filters inside the scan."""
    assert derive(query).predicate_pushed is True


def test_projection_efficiency_is_a_fraction(query):
    """The fixture reads every column, so the ratio is exactly 1."""
    assert derive(query).projection_efficiency == 1


def test_projection_efficiency_spans_both_plans():
    """Columns read are on the physical scan; the file's width is on the IR.

    Reading either plan alone leaves one half of the ratio missing, which is
    why this was silently None.
    """
    physical = build_plan(
        [
            {
                "id": 0,
                "input_ids": [],
                "properties": {"type": "MultiScan", "projected_file_columns": ["a", "b"]},
            }
        ]
    )
    logical = build_plan(
        [
            {
                "id": 0,
                "input_ids": [],
                "properties": {"type": "Scan", "file_columns": ["a", "b", "c", "d"]},
            }
        ]
    )
    query = Query(query_id=uuid4(), wall_ms=1.0, plan=physical, logical=logical)
    assert derive(query).projection_efficiency == 0.5


def test_projection_efficiency_is_absent_without_an_ir_plan():
    physical = build_plan(
        [
            {
                "id": 0,
                "input_ids": [],
                "properties": {"type": "MultiScan", "projected_file_columns": ["a"]},
            }
        ]
    )
    query = Query(query_id=uuid4(), wall_ms=1.0, plan=physical)
    assert derive(query).projection_efficiency is None


def test_morsel_skew_is_at_least_one(query):
    d = derive(query)
    assert d.morsel_skew is None or d.morsel_skew >= 1


def test_completeness_tracks_unfinished_nodes(query):
    d = derive(query)
    assert d.complete is (d.incomplete_nodes == 0)


def test_incomplete_snapshot_is_reported(query):
    """Counters are a floor when a node had not finished; say so."""
    import dataclasses

    partial = dict(query.metrics)
    first = next(iter(partial))
    partial[first] = dataclasses.replace(partial[first], done=False)
    altered = dataclasses.replace(query, metrics=partial)

    d = derive(altered)
    assert d.incomplete_nodes == 1
    assert d.complete is False


def test_query_without_metrics_yields_empty_diagnostics():
    empty = Query(query_id=uuid4(), wall_ms=1.0, plan={})
    d = derive(empty)
    assert d.parallel_efficiency is None
    assert d.complete is True


def test_plan_signals_survive_without_node_metrics(query):
    """Config(node_metrics=False) must not blank what the plan alone says."""
    without = Query(
        query_id=query.query_id, wall_ms=query.wall_ms, plan=query.plan, logical=query.logical
    )
    d = derive(without)

    assert d.predicate_pushed is True
    assert d.projection_efficiency == 1
    assert d.parallel_efficiency is None, "metric-derived signals are still absent"


def _join_query(left: int, right: int, out: int, *, kind: str = "EquiJoin", fan_out: int = 1):
    """Two scans into a join; the right scan optionally feeds `fan_out` consumers."""
    nodes = [
        {"id": 1, "input_ids": [], "properties": {"type": "MultiScan"}},
        {"id": 2, "input_ids": [], "properties": {"type": "MultiScan"}},
        {"id": 3, "input_ids": [1, 2], "properties": {"type": kind}},
    ]
    nodes += [
        {"id": 10 + i, "input_ids": [2], "properties": {"type": "Select"}}
        for i in range(fan_out - 1)
    ]
    metrics = [
        {"phys_node_key": key, "rows_sent": rows, "rows_received": 0, "done": True}
        for key, rows in ((1, left), (2, right * fan_out), (3, out))
    ]
    return Query(
        query_id=uuid4(), wall_ms=1.0, plan=build_plan(nodes), metrics=build_metrics(metrics)
    )


def test_join_growth_compares_with_the_larger_input():
    """A small table joined to a big one is not fan-out, whichever side comes first."""
    diagnostics = derive(_join_query(left=100, right=1_000_000, out=1_000_000))
    assert diagnostics.join_growth == 1.0


def test_join_growth_shows_many_to_many_keys():
    assert derive(_join_query(left=2_000, right=1_000, out=10_000)).join_growth == 5.0
    assert derive(_join_query(left=3, right=4, out=12, kind="CrossJoin")).join_growth == 3.0


def test_join_growth_counts_a_shared_input_once_per_consumer():
    """A Multiplexer's rows_sent adds up every copy it hands out."""
    assert derive(_join_query(left=10, right=1_000, out=1_000, fan_out=4)).join_growth == 1.0


def test_join_growth_is_absent_without_a_join():
    assert derive(_join_query(left=1, right=1, out=1, kind="Select")).join_growth is None


def test_parallel_efficiency_counts_the_threads_polars_has_not_the_machine():
    """polars' pool follows CPU affinity, a cgroup quota and POLARS_MAX_THREADS."""
    import os
    import subprocess
    import sys

    script = "from polars_telemetry.adapter.build import threads; print(threads())"
    env = {**os.environ, "POLARS_MAX_THREADS": "3"}
    out = subprocess.run(  # noqa: S603
        [sys.executable, "-c", script], capture_output=True, text=True, env=env, check=True
    )
    assert out.stdout.strip() == "3"
