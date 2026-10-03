"""Simulated interface breaks are detected and never propagate.

Each case mutates a real captured payload the way a polars change plausibly
would. The point is not that we keep working -- it is that we notice, and that
the caller's query is unaffected either way.
"""

from __future__ import annotations

import copy
import json
from uuid import uuid4

import msgpack
import pytest

from polars_telemetry._safety import FailureTracker
from polars_telemetry.adapter.decode import (
    decode_optional_plan,
    metrics_additions,
    metrics_breaks,
    metrics_problems,
    plan_problems,
)
from polars_telemetry.adapter.hook import QueryObserver
from polars_telemetry.adapter.recorder import QueryRecorder
from polars_telemetry.config import Config
from polars_telemetry.model.types import Query
from tests.fixture_paths import latest_fixture
from tests.unit.test_hook import Log

FIXTURE = latest_fixture()


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


def _record(ir_plan: bytes, physical_plan: bytes) -> tuple[list[Query], FailureTracker]:
    emitted: list[Query] = []
    tracker = FailureTracker("observer")
    recorder = QueryRecorder(Config(), emitted.append, tracker)
    query_id = uuid4()
    recorder.started(query_id)
    recorder.planned(query_id, ir_plan, physical_plan, None)
    recorder.closed()
    return emitted, tracker


@pytest.mark.parametrize(
    "payload",
    [b"\xc1not-msgpack", msgpack.packb({"unexpected": "shape"})],
    ids=["not msgpack", "not a list"],
)
def test_an_unreadable_plan_still_yields_the_query(payload):
    """A payload polars has reshaped costs that plan, not the query span."""
    emitted, tracker = _record(payload, payload)

    assert len(emitted) == 1
    assert emitted[0].plan == {}
    assert emitted[0].logical == {}
    assert not tracker.disarmed
    assert tracker.errors == 0, "noted, never counted toward disarming"


def test_an_added_callback_argument_does_not_escape():
    """If polars passes callbacks a new argument, we keep working."""
    log = Log()
    tracker = FailureTracker("observer")
    observer = QueryObserver(log, tracker)

    observer.on_query_started("q", "new_argument")
    observer.on_query_planned("q", None, b"", b"", "new_argument").close()

    assert log.events == ["started", "planned", "closed"]
    assert tracker.errors == 0


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
