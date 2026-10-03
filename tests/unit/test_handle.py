"""Settling the closing snapshot."""

from __future__ import annotations

from typing import Any

import msgpack

from polars_telemetry.adapter.handle import MetricsHandle


class Stub:
    """A metrics handle whose snapshots follow a script."""

    def __init__(self, *snapshots: list[dict[str, Any]]) -> None:
        self.snapshots = list(snapshots)
        self.calls = 0

    def snapshot_query_metrics(self) -> bytes:
        self.calls += 1
        index = min(self.calls, len(self.snapshots)) - 1
        return msgpack.packb(self.snapshots[index])


def test_a_snapshot_still_settling_is_retaken():
    raw = Stub([{"done": False}], [{"done": True}])
    assert MetricsHandle(raw).settled_snapshot() == [{"done": True}]
    assert raw.calls == 2


def test_a_snapshot_already_settled_is_taken_once():
    raw = Stub([{"done": True}])
    MetricsHandle(raw).settled_snapshot()
    assert raw.calls == 1


def test_without_a_done_flag_nothing_is_retried():
    """Had polars renamed `done`, every query would pay the whole retry budget."""
    raw = Stub([{"rows_sent": 1}])
    MetricsHandle(raw).settled_snapshot()
    assert raw.calls == 1


def test_a_snapshot_that_never_settles_gives_up():
    raw = Stub([{"done": False}])
    MetricsHandle(raw).settled_snapshot()
    assert raw.calls == 6, "one snapshot plus five retries, then the last one stands"
