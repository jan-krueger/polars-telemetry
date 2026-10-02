"""Model construction from captured payloads."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from polars_telemetry.model.build import build_plan, build_sample
from polars_telemetry.model.types import Query

FIXTURE = sorted(p for p in (Path(__file__).parents[1] / "fixtures").iterdir() if p.is_dir())[-1]


@pytest.fixture
def query():
    plan = build_plan(json.loads((FIXTURE / "physical.json").read_text()))
    sample = build_sample(12.0, json.loads((FIXTURE / "metrics.json").read_text()))
    return Query(
        query_id=uuid4(),
        wall_ms=20.0,
        plan=plan,
        samples=(sample,),
        sample_interval_ms=None,
    )


def test_plan_nodes_are_indexed_by_id(query):
    assert query.plan
    for node_id, node in query.plan.items():
        assert node.node_id == node_id
        assert node.kind


def test_plan_inputs_resolve(query):
    for node in query.plan.values():
        for parent in node.inputs:
            assert parent in query.plan


def test_metrics_cover_every_plan_node(query):
    final = query.final
    assert final is not None
    assert set(final.nodes) <= set(query.plan)


def test_cpu_time_is_positive(query):
    assert query.cpu_ms > 0


def test_result_rows_come_from_the_sink(query):
    assert query.result_rows is not None
    assert query.result_rows >= 0


def test_query_without_samples_degrades_cleanly():
    empty = Query(query_id=uuid4(), wall_ms=5.0, plan={}, samples=(), sample_interval_ms=None)
    assert empty.final is None
    assert empty.cpu_ms == 0.0
    assert empty.parallelism == 0.0
    assert empty.result_rows is None
