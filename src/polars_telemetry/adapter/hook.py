"""The observer protocol polars calls, and nothing else.

Checked against every polars version in CI by tests/contract::

    polars_cloud.authenticate()
    polars_cloud.QueryCloudObserver(workspace, organization) -> observer
    observer.on_query_started(query_id: UUID)
    observer.on_query_planned(query_id, handle, ir: bytes, phys: bytes) -> guard
    observer.on_query_failed(...)
    guard.close()

Names and signatures are dictated by polars and must not be renamed; a change
to them is a change to this module only. Each callback is translated into a
call on a `Recorder` and contained: polars calls close() on whatever
on_query_planned returns, so that method returns a guard even when it has
failed internally. The real polars-cloud observer, when installed, is
forwarded every callback.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Protocol

from polars_telemetry._safety import FailureTracker

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

_log = logging.getLogger("polars_telemetry")


class Recorder(Protocol):
    """What a query's callbacks are translated into."""

    def started(self, query_id: UUID) -> None: ...
    def planned(
        self, query_id: UUID, ir_plan: bytes, physical_plan: bytes, handle: Any
    ) -> None: ...
    def failed(self, message: str) -> None: ...
    def closed(self) -> None: ...


def _message(args: tuple[Any, ...]) -> str:
    """The failure text polars passed, whatever position it arrived in."""
    for arg in args:
        if isinstance(arg, str) and arg:
            return arg
    return "unknown"


class ObserverFactory:
    """Called by polars once per query; makes that query's observer."""

    __slots__ = ("_delegate", "_delegate_errors", "_make_recorder", "_tracker")

    def __init__(
        self,
        make_recorder: Callable[[FailureTracker], Recorder],
        delegate: Any | None = None,
        *,
        label: str = "observer",
    ) -> None:
        """delegate: the real polars-cloud factory, if one was installed."""
        self._make_recorder = make_recorder
        self._delegate = delegate
        self._delegate_errors: set[str] = set()
        self._tracker = FailureTracker(label)

    @property
    def tracker(self) -> FailureTracker:
        return self._tracker

    def __call__(
        self, workspace: str | None = None, organization: str | None = None
    ) -> QueryObserver:
        delegate = None
        if self._delegate is not None:
            try:
                delegate = self._delegate(workspace, organization)
            except Exception as exc:
                self._report_delegate(exc)
        return QueryObserver(self._make_recorder(self._tracker), self._tracker, delegate)

    def _report_delegate(self, exc: Exception) -> None:
        key = f"{type(exc).__name__}: {exc}"
        if key not in self._delegate_errors:
            self._delegate_errors.add(key)
            _log.warning("polars-telemetry: the polars-cloud observer failed (%s).", key)


class QueryObserver:
    """One query's callbacks. Each is contained, so polars never sees ours fail."""

    __slots__ = ("_delegate", "_recorder", "_tracker")

    def __init__(
        self, recorder: Recorder, tracker: FailureTracker, delegate: Any | None = None
    ) -> None:
        self._recorder = recorder
        self._tracker = tracker
        self._delegate = delegate

    def on_query_started(self, *args: Any) -> None:
        if not self._tracker.disarmed:
            try:
                self._recorder.started(args[0])
            except Exception as exc:
                self._tracker.record(exc)
        self._forward("on_query_started", *args)

    def on_query_planned(self, *args: Any) -> ExecutionGuard:
        delegate_guard = self._forward("on_query_planned", *args)
        if not self._tracker.disarmed:
            try:
                query_id, handle, ir_plan, physical_plan = args[:4]
                self._recorder.planned(query_id, ir_plan, physical_plan, handle)
            except Exception as exc:
                self._tracker.record(exc)
        return ExecutionGuard(self, delegate_guard)

    def on_query_failed(self, *args: Any) -> None:
        if not self._tracker.disarmed:
            try:
                self._recorder.failed(_message(args))
            except Exception as exc:
                self._tracker.record(exc)
        self._forward("on_query_failed", *args)

    def close_query(self) -> None:
        """Called by the guard when polars ends the query."""
        if self._tracker.disarmed:
            return
        try:
            self._recorder.closed()
        except Exception as exc:
            self._tracker.record(exc)

    def _forward(self, method: str, *args: Any) -> Any:
        """Pass the callback on to polars-cloud, when it is also installed."""
        if self._delegate is None:
            return None
        try:
            return getattr(self._delegate, method)(*args)
        except Exception as exc:
            _log.warning("polars-telemetry: delegate %s failed: %s", method, exc)
            return None


class ExecutionGuard:
    """Returned from on_query_planned; polars calls close() at query end."""

    __slots__ = ("_delegate_guard", "_observer")

    def __init__(self, observer: QueryObserver, delegate_guard: Any | None = None) -> None:
        self._observer = observer
        self._delegate_guard = delegate_guard

    def close(self) -> None:
        self._observer.close_query()
        if self._delegate_guard is not None:
            try:
                self._delegate_guard.close()
            except Exception as exc:
                _log.warning("polars-telemetry: delegate guard close failed: %s", exc)
