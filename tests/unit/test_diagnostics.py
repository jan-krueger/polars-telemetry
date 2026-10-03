"""Derived diagnostics."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.model.diagnostics import derive
from polars_telemetry.model.types import Query

FIXTURE = sorted(p for p in (Path(__file__).parents[1] / "fixtures").iterdir() if p.is_dir())[-1]


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
