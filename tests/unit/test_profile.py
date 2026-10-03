"""The profile document — the contract a viewer codes against."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest

from polars_telemetry.adapter.build import build_metrics, build_plan, enrich
from polars_telemetry.export.profile import SCHEMA, build_profile
from polars_telemetry.model.types import NodeMetrics, Query

FIXTURE = sorted(p for p in (Path(__file__).parents[1] / "fixtures").iterdir() if p.is_dir())[-1]


@pytest.fixture
def query():
    # Enriched as ingress would, so the fingerprint and diagnostics are set.
    return enrich(
        Query(
            query_id=uuid4(),
            wall_ms=40.0,
            plan=build_plan(json.loads((FIXTURE / "physical.json").read_text())),
            logical=build_plan(json.loads((FIXTURE / "ir.json").read_text())),
            metrics=build_metrics(json.loads((FIXTURE / "metrics.json").read_text())),
            started_unix_ns=1_700_000_000_000_000_000,
        )
    )


def test_document_is_self_describing(query):
    doc = build_profile(query)
    assert doc["schema"] == SCHEMA
    assert doc["polars_version"]
    assert doc["polars_telemetry_version"]


def test_both_versions_are_recorded(query):
    """Two sources of change: this schema, and polars' counter set."""
    doc = build_profile(query)
    assert "polars_version" in doc
    assert "polars_telemetry_version" in doc


def test_carries_both_plans_with_properties(query):
    plan = build_profile(query)["plan"]
    assert plan["physical"]
    assert plan["logical"]
    for node in plan["physical"]:
        assert {"id", "kind", "inputs", "properties"} <= node.keys()
    # Properties are what let a viewer label nodes with the user's own columns.
    assert any(n["properties"].get("keys") for n in plan["logical"] if n["kind"] == "GroupBy")


def test_every_counter_polars_delivers_is_in_the_document(query):
    import dataclasses

    expected = {f.name for f in dataclasses.fields(NodeMetrics)} - {"node_id"}
    physical = build_profile(query)["plan"]["physical"]
    with_metrics = [n for n in physical if "metrics" in n]
    assert with_metrics
    for node in with_metrics:
        assert set(node["metrics"]) == expected


def test_is_json_serialisable(query):
    blob = json.dumps(build_profile(query))
    assert json.loads(blob)["schema"] == SCHEMA


def test_diagnostics_omit_absent_signals(query):
    diagnostics = build_profile(query)["diagnostics"]
    assert None not in diagnostics.values()
    assert "parallel_efficiency" in diagnostics


def test_fingerprint_matches_the_shape(query):
    from polars_telemetry.adapter.fingerprint import fingerprint

    assert build_profile(query)["fingerprint"] == fingerprint(query.logical)


def test_every_node_carries_its_role(query):
    """Readers use the role rather than re-learning polars' kind names."""
    from polars_telemetry.model.types import NodeRole

    document = build_profile(query)
    roles = {
        NodeRole(n["role"]) for side in ("physical", "logical") for n in document["plan"][side]
    }
    assert NodeRole.UNKNOWN not in roles
    assert NodeRole.JOIN in roles
