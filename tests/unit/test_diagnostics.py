"""Derived diagnostics."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from polars_telemetry.model.build import build_metrics, build_plan
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
    d = derive(query)
    if d.projection_efficiency is not None:
        assert 0 < d.projection_efficiency <= 1


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
