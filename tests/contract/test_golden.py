"""Golden contract: the checked-in fixtures still match the known shape.

Offline. Catches regressions in our decoder, not changes in polars.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from polars_telemetry.adapter.decode import (
    METRIC_FIELDS,
    decode_metrics,
    decode_plan,
    metrics_problems,
    plan_problems,
)

pytestmark = pytest.mark.contract

FIXTURES = sorted(p for p in (Path(__file__).parents[1] / "fixtures").iterdir() if p.is_dir())


def _ids(paths: list[Path]) -> list[str]:
    return [p.name for p in paths]


@pytest.fixture(params=FIXTURES, ids=_ids(FIXTURES))
def captured(request: pytest.FixtureRequest) -> Path:
    return request.param


def test_at_least_one_fixture_version_exists() -> None:
    assert FIXTURES, "no captured fixtures; run `just capture <version>`"


@pytest.mark.parametrize("plan", ["ir", "physical"])
def test_plan_matches_contract(captured: Path, plan: str) -> None:
    records = decode_plan((captured / f"{plan}.msgpack").read_bytes())
    assert plan_problems(records) == []


def test_metrics_match_contract(captured: Path) -> None:
    records = decode_metrics((captured / "metrics.msgpack").read_bytes())
    assert metrics_problems(records) == []


def test_metric_fields_are_exactly_the_known_set(captured: Path) -> None:
    records = decode_metrics((captured / "metrics.msgpack").read_bytes())
    assert set(records[0]) == METRIC_FIELDS


def test_metrics_key_onto_physical_plan_nodes(captured: Path) -> None:
    """phys_node_key is what lets us attribute metrics without name matching."""
    plan = decode_plan((captured / "physical.msgpack").read_bytes())
    metrics = decode_metrics((captured / "metrics.msgpack").read_bytes())

    plan_ids = {node["id"] for node in plan}
    metric_ids = {record["phys_node_key"] for record in metrics}
    assert metric_ids <= plan_ids


def test_capture_query_covers_the_node_kinds_we_care_about(captured: Path) -> None:
    plan = decode_plan((captured / "physical.msgpack").read_bytes())
    kinds = {node["properties"]["type"] for node in plan}
    assert {"MultiScan", "EquiJoin", "GroupBy", "Sort"} <= kinds


def test_decoded_json_matches_the_msgpack(captured: Path) -> None:
    """The reviewable JSON must not drift from the binary it documents."""
    for name in ("ir", "physical", "metrics"):
        blob = decode_plan((captured / f"{name}.msgpack").read_bytes())
        sidecar = json.loads((captured / f"{name}.json").read_text())
        assert blob == sidecar, f"{name}.json is stale; re-run the capture"
