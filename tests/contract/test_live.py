"""Live contract: the installed polars still behaves like the fixtures.

This is what the nightly canary runs against unreleased polars. A failure here
means polars changed the interface, not that our code regressed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from polars_telemetry.adapter.decode import (
    METRIC_FIELDS,
    decode_metrics,
    decode_plan,
    metrics_problems,
    plan_problems,
)

pytestmark = [pytest.mark.contract, pytest.mark.live]

polars = pytest.importorskip("polars")

CAPTURE = Path(__file__).parents[1] / "tools" / "capture.py"


@pytest.fixture(scope="module")
def live(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """Run the capture tool in a subprocess and read back what polars gave it.

    A subprocess because enabling monitoring is a process-wide, one-way change
    to polars' engine affinity.
    """
    import subprocess
    import sys

    out = tmp_path_factory.mktemp("live")
    result = subprocess.run(  # noqa: S603
        [sys.executable, str(CAPTURE), str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.fail(f"capture failed:\n{result.stdout}\n{result.stderr}")

    return {
        "ir": decode_plan((out / "ir.msgpack").read_bytes()),
        "physical": decode_plan((out / "physical.msgpack").read_bytes()),
        "metrics": decode_metrics((out / "metrics.msgpack").read_bytes()),
        "meta": json.loads((out / "meta.json").read_text()),
    }


def test_observer_hook_is_still_reachable(live: dict[str, Any]) -> None:
    """The whole package rests on polars calling a module it finds by name."""
    assert live["physical"], "polars did not deliver a physical plan"
    assert live["metrics"], "polars did not deliver metrics"


@pytest.mark.parametrize("plan", ["ir", "physical"])
def test_live_plan_matches_contract(live: dict[str, Any], plan: str) -> None:
    assert plan_problems(live[plan]) == []


def test_live_metrics_match_contract(live: dict[str, Any]) -> None:
    assert metrics_problems(live["metrics"]) == []


def test_live_metric_fields_have_not_changed(live: dict[str, Any]) -> None:
    observed = set(live["metrics"][0])
    assert observed == METRIC_FIELDS, (
        f"polars {live['meta']['polars_version']} changed the metrics schema; "
        f"added={sorted(observed - METRIC_FIELDS)} removed={sorted(METRIC_FIELDS - observed)}"
    )


def test_live_metrics_key_onto_plan(live: dict[str, Any]) -> None:
    plan_ids = {node["id"] for node in live["physical"]}
    metric_ids = {record["phys_node_key"] for record in live["metrics"]}
    assert metric_ids <= plan_ids
