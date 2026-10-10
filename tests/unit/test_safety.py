"""Failure isolation behaviour, through the observer polars actually calls."""

from __future__ import annotations

import logging
from typing import Any

import pytest

from polars_telemetry._safety import FailureTracker
from polars_telemetry.adapter.hook import QueryObserver


class Failing:
    """A recorder whose every callback raises the given exception."""

    def __init__(self, exc: BaseException) -> None:
        self.exc = exc
        self.calls = 0

    def _fail(self, *args: Any) -> None:
        self.calls += 1
        raise self.exc

    started = planned = failed = closed = release = _fail


def test_a_failing_recorder_never_reaches_polars():
    tracker = FailureTracker("observer")
    observer = QueryObserver(Failing(ValueError("nope")), tracker)

    observer.on_query_started("q")
    guard = observer.on_query_planned("q", None, b"", b"")
    guard.close()
    assert tracker.errors == 3


def test_distinct_errors_are_logged_once_each(caplog):
    tracker = FailureTracker("adapter")
    with caplog.at_level(logging.WARNING, logger="polars_telemetry"):
        for message in ("same", "same", "same", "different"):
            tracker.record(ValueError(message))

    assert len([r for r in caplog.records if "failed" in r.message]) == 2
    assert tracker.errors == 4


def test_disarms_after_threshold_and_stops_calling():
    recorder = Failing(RuntimeError("bang"))
    tracker = FailureTracker("observer", max_errors=3)
    observer = QueryObserver(recorder, tracker)

    for _ in range(10):
        observer.on_query_started("q")

    assert tracker.disarmed
    assert recorder.calls == 3, "calls must stop once disarmed"


def test_base_exception_is_not_swallowed():
    """KeyboardInterrupt and SystemExit must still reach the caller."""
    tracker = FailureTracker("observer")
    observer = QueryObserver(Failing(KeyboardInterrupt()), tracker)

    with pytest.raises(KeyboardInterrupt):
        observer.on_query_started("q")
    assert tracker.errors == 0


def test_a_noted_payload_departure_never_disarms(caplog):
    """polars reshaping a payload fails identically on every query; counting
    that would switch off spans that never needed the payload."""
    tracker = FailureTracker("observer")
    for _ in range(20):
        tracker.note(ValueError("reshaped"), "IR plan")

    assert not tracker.disarmed
    assert tracker.errors == 0
    assert sum("IR plan" in r.getMessage() for r in caplog.records) == 1, "logged once"
