"""Failure isolation behaviour."""

from __future__ import annotations

import logging

import pytest

from polars_telemetry._safety import FailureTracker, fail_soft


def test_successful_calls_pass_through():
    tracker = FailureTracker("x")

    @fail_soft(tracker)
    def add(a, b):
        return a + b

    assert add(1, 2) == 3
    assert tracker.errors == 0


def test_exceptions_become_none():
    tracker = FailureTracker("x")

    @fail_soft(tracker)
    def boom():
        raise ValueError("nope")

    assert boom() is None
    assert tracker.errors == 1


def test_distinct_errors_are_logged_once_each(caplog):
    tracker = FailureTracker("adapter")

    @fail_soft(tracker)
    def boom(message):
        raise ValueError(message)

    with caplog.at_level(logging.WARNING, logger="polars_telemetry"):
        for _ in range(3):
            boom("same")
        boom("different")

    logged = [r for r in caplog.records if "failed" in r.message]
    assert len(logged) == 2
    assert tracker.errors == 4


def test_disarms_after_threshold_and_stops_calling():
    tracker = FailureTracker("x", max_errors=3)
    calls = 0

    @fail_soft(tracker)
    def boom():
        nonlocal calls
        calls += 1
        raise RuntimeError("bang")

    for _ in range(10):
        boom()

    assert tracker.disarmed
    assert calls == 3, "calls must stop once disarmed"


def test_base_exception_is_not_swallowed():
    """KeyboardInterrupt and SystemExit must still reach the caller."""
    tracker = FailureTracker("x")

    @fail_soft(tracker)
    def interrupted():
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        interrupted()
    assert tracker.errors == 0


def test_wrapper_preserves_metadata():
    tracker = FailureTracker("x")

    @fail_soft(tracker)
    def documented():
        """Docstring."""

    assert documented.__name__ == "documented"
    assert documented.__doc__ == "Docstring."


def test_a_noted_payload_departure_never_disarms(caplog):
    """polars reshaping a payload fails identically on every query; counting
    that would switch off spans that never needed the payload."""
    tracker = FailureTracker("observer")
    for _ in range(20):
        tracker.note(ValueError("reshaped"), "IR plan")

    assert not tracker.disarmed
    assert tracker.errors == 0
    assert sum("IR plan" in r.getMessage() for r in caplog.records) == 1, "logged once"
