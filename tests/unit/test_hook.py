"""polars' callback protocol, translated onto a recorder."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from polars_telemetry.adapter.hook import ExecutionGuard, ObserverFactory


class Log:
    def __init__(self, _tracker: Any = None) -> None:
        self.events: list[str] = []

    def started(self, query_id: Any) -> None:
        self.events.append("started")

    def planned(self, query_id: Any, ir_plan: bytes, physical_plan: bytes, handle: Any) -> None:
        self.events.append("planned")

    def failed(self, message: str) -> None:
        self.events.append(f"failed:{message}")

    def closed(self) -> None:
        self.events.append("closed")


class Raises(Log):
    def planned(self, *args: Any) -> None:
        msg = "recorder bug"
        raise RuntimeError(msg)


def test_each_callback_reaches_the_recorder_in_order():
    log = Log()
    observer = ObserverFactory(lambda _: log)()
    observer.on_query_started(uuid4())
    observer.on_query_planned(uuid4(), None, b"", b"").close()
    assert log.events == ["started", "planned", "closed"]


def test_the_failure_text_is_passed_whatever_its_position():
    log = Log()
    observer = ObserverFactory(lambda _: log)()
    observer.on_query_failed(uuid4(), "column 'x' not found")
    assert log.events == ["failed:column 'x' not found"]


def test_a_failing_recorder_still_yields_a_guard_and_never_raises():
    """polars calls close() on whatever on_query_planned returns."""
    factory = ObserverFactory(lambda _: Raises())
    guard = factory().on_query_planned(uuid4(), None, b"", b"")
    assert isinstance(guard, ExecutionGuard)
    guard.close()
    assert factory.tracker.errors == 1


def test_polars_cloud_is_forwarded_every_callback():
    calls: list[str] = []

    class Cloud:
        def on_query_started(self, *_: Any) -> None:
            calls.append("started")

        def on_query_planned(self, *_: Any) -> Any:
            calls.append("planned")
            return self

        def close(self) -> None:
            calls.append("closed")

    observer = ObserverFactory(Log, delegate=lambda *_: Cloud())()
    observer.on_query_started(uuid4())
    observer.on_query_planned(uuid4(), None, b"", b"").close()
    assert calls == ["started", "planned", "closed"]
