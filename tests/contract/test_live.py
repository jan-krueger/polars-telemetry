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
from polars_telemetry.adapter.dialect import unknown_kinds

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


@pytest.mark.parametrize("plan", ["ir", "physical"])
def test_live_node_kinds_are_all_recognised(live: dict[str, Any], plan: str) -> None:
    """The canary's tripwire for a renamed operator: structure checks pass on a
    rename, and attributes keyed on the old name quietly vanish."""
    assert unknown_kinds(r["properties"]["type"] for r in live[plan]) == []


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


_FALLBACK = """
import json, os, sys
import polars as pl
import polars_telemetry as pt
lf = pl.LazyFrame({"g": [i % 7 for i in range(1_000)], "v": list(range(1_000))})
with pt.profile(pt.Config(describe_fallbacks=sys.argv[1] == "on")) as session:
    lf.with_columns(r=pl.col("v").rank().over("g")).collect()
nodes = [n for d in session.profiles() for n in d["plan"]["physical"]]
fallbacks = [n["properties"] for n in nodes if n["kind"] == "InMemoryMap"]
env = os.environ.get("POLARS_STREAM_ALWAYS_PREPARE_VISUALIZATION_DATA")
print(json.dumps({"fallbacks": fallbacks, "env": env}))
"""


@pytest.mark.parametrize("describe", ["on", "off"])
def test_an_in_memory_fallback_says_what_it_runs_only_when_asked(describe: str) -> None:
    """The switch is undocumented in polars; this fails when a release drops it."""
    import os
    import subprocess
    import sys

    env = {
        k: v
        for k, v in os.environ.items()
        if k != "POLARS_STREAM_ALWAYS_PREPARE_VISUALIZATION_DATA"
    }
    out = subprocess.run(  # noqa: S603
        [sys.executable, "-c", _FALLBACK, describe],
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["fallbacks"], "rank().over() no longer falls back to the in-memory engine"
    described = [props.get("format_str") for props in result["fallbacks"]]
    if describe == "on":
        assert all(text and ".rank(" in text for text in described)
    else:
        assert described == [None] * len(described)
    assert result["env"] is None, "uninstall() must put the variable back"


_TRAITS = """
import json
import polars as pl
import polars_telemetry as pt
lf = pl.LazyFrame(
    {
        "g": [i % 7 for i in range(1_000)],
        "s": [f"x{i}" for i in range(1_000)],
        "day": [f"2024-01-{i % 28 + 1:02d}" for i in range(1_000)],
    }
)
query = lf.with_columns(
    t=pl.col("s").str.replace("1", "a").str.replace("2", "b").str.replace("3", "c")
    .str.replace("4", "d"),
    d=pl.col("day").str.to_datetime(),
    r=pl.col("g").rank().over("g"),
)
with pt.profile() as session:
    query.collect()
print(json.dumps([n for d in session.profiles() for n in d["plan"]["physical"]]))
"""


def test_traits_read_what_polars_writes_today() -> None:
    """Breaks when polars changes the kind names or expression text traits read."""
    import subprocess
    import sys

    from polars_telemetry.adapter.traits import traits

    out = subprocess.run(  # noqa: S603
        [sys.executable, "-c", _TRAITS], capture_output=True, text=True, check=True
    )
    nodes = json.loads(out.stdout.strip().splitlines()[-1])
    found = [traits(n["kind"], n.get("properties") or {}) for n in nodes]
    assert any(t.in_memory_fallback for t in found), "rank().over() no longer falls back"
    assert any(t.infers_datetime_format for t in found), "to_datetime() no longer infers"
    replaces = [c.count for t in found for c in t.string_calls if c.function == "replace"]
    assert max(replaces, default=0) == 4, "the str.replace chain is no longer read"
