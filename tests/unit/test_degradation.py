"""Simulated interface breaks are detected and never propagate.

Each case mutates a real captured payload the way a polars change plausibly
would. The point is not that we keep working -- it is that we notice, and that
the caller's query is unaffected either way.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import msgpack
import pytest

from polars_telemetry._safety import FailureTracker, fail_soft
from polars_telemetry.adapter.decode import (
    decode_metrics,
    decode_optional_plan,
    decode_plan,
    metrics_additions,
    metrics_breaks,
    metrics_problems,
    plan_problems,
)

FIXTURE = sorted(p for p in (Path(__file__).parents[1] / "fixtures").iterdir() if p.is_dir())[-1]


@pytest.fixture
def metrics():
    return json.loads((FIXTURE / "metrics.json").read_text())


@pytest.fixture
def plan():
    return json.loads((FIXTURE / "physical.json").read_text())


def test_baseline_fixture_is_clean(metrics, plan):
    assert metrics_problems(metrics) == []
    assert plan_problems(plan) == []


def test_renamed_metric_field_is_detected(metrics):
    mutated = copy.deepcopy(metrics)
    for record in mutated:
        record["rows_in"] = record.pop("rows_received")

    problems = metrics_problems(mutated)
    assert any("rows_received" in p for p in problems)
    assert any("rows_in" in p for p in problems)


def test_added_metric_field_is_detected(metrics):
    mutated = copy.deepcopy(metrics)
    for record in mutated:
        record["spill_bytes"] = 0

    assert any("spill_bytes" in p for p in metrics_problems(mutated))


def test_changed_metric_type_is_detected(metrics):
    mutated = copy.deepcopy(metrics)
    mutated[0]["rows_sent"] = "12"

    assert any("rows_sent" in p for p in metrics_problems(mutated))


def test_empty_payload_is_detected():
    assert metrics_problems([]) == ["metrics payload is empty"]
    assert plan_problems([]) == ["plan payload is empty"]


def test_plan_node_missing_properties_is_detected(plan):
    mutated = copy.deepcopy(plan)
    del mutated[0]["properties"]

    assert any("missing fields" in p for p in plan_problems(mutated))


def test_dangling_input_reference_is_detected(plan):
    mutated = copy.deepcopy(plan)
    mutated[0]["input_ids"] = [999_999]

    assert any("unknown nodes" in p for p in plan_problems(mutated))


def test_corrupt_payload_does_not_escape_the_guard():
    """A payload we cannot parse at all must not reach the caller."""
    tracker = FailureTracker("decode")
    guarded = fail_soft(tracker)(decode_plan)

    assert guarded(b"\xc1not-msgpack") is None
    assert tracker.errors == 1


def test_non_list_payload_does_not_escape_the_guard():
    tracker = FailureTracker("decode")
    guarded = fail_soft(tracker)(decode_metrics)

    assert guarded(msgpack.packb({"unexpected": "shape"})) is None
    assert tracker.errors == 1


def test_callback_arity_change_does_not_escape_the_guard():
    """If polars adds a callback argument, we must degrade, not raise."""
    tracker = FailureTracker("observer")

    @fail_soft(tracker)
    def on_query_planned(query_id, handle, ir, phys):
        return "ok"

    assert on_query_planned(1, 2, 3, 4, "new_argument") is None  # type: ignore[call-arg]
    assert tracker.errors == 1


def test_nil_physical_plan_is_not_an_error():
    """Eager DataFrame operations arrive with a nil physical plan."""
    assert decode_optional_plan(msgpack.packb(None)) is None


def test_nil_payload_still_rejects_a_wrong_shape():
    with pytest.raises(ValueError, match="expected a list payload"):
        decode_optional_plan(msgpack.packb({"unexpected": "shape"}))


def test_an_added_counter_is_reported_but_does_not_degrade(metrics):
    """polars adding a counter must not cost everyone their node metrics."""
    mutated = copy.deepcopy(metrics)
    for record in mutated:
        record["spill_bytes"] = 0

    assert any("spill_bytes" in p for p in metrics_additions(mutated))
    assert metrics_breaks(mutated) == []


def test_a_removed_counter_still_degrades(metrics):
    mutated = copy.deepcopy(metrics)
    for record in mutated:
        del record["rows_sent"]

    assert any("rows_sent" in p for p in metrics_breaks(mutated))


def test_a_retyped_counter_still_degrades(metrics):
    mutated = copy.deepcopy(metrics)
    for record in mutated:
        record["rows_sent"] = "many"

    assert any("rows_sent" in p for p in metrics_breaks(mutated))
