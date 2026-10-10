"""Which receivers make running queries worth sampling."""

from __future__ import annotations

from polars_telemetry import _dispatch


def _with(**hooks: object) -> bool:
    receiver = _dispatch.add(lambda query: None, "test", **hooks)  # type: ignore[arg-type]
    try:
        return _dispatch.wants_progress()
    finally:
        _dispatch.remove(receiver)


def test_sampling_is_wanted_by_a_receiver_with_started_or_progress():
    assert _with(started=lambda query: None)
    assert _with(progress=lambda progress: None)


def test_sampling_is_not_wanted_by_a_receiver_that_only_exports():
    assert not _with()
