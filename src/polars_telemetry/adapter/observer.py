"""The observer protocol polars calls.

Verified against polars 1.44.1 and 1.44.2::

    polars_cloud.authenticate()
    polars_cloud.QueryCloudObserver(workspace, organization) -> observer
    observer.on_query_started(query_id: UUID)
    observer.on_query_planned(query_id, handle, ir: bytes, phys: bytes) -> guard
    observer.on_query_failed(...)
    guard.close()

Names and signatures are dictated by polars and must not be renamed. Every
method swallows its own failures: polars calls close() on whatever
on_query_planned returns, so that method must return a guard even when it has
failed internally.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

from polars_telemetry._safety import FailureTracker
from polars_telemetry.adapter.decode import decode_plan
from polars_telemetry.adapter.handle import MetricsHandle
from polars_telemetry.model.build import build_plan
from polars_telemetry.model.sampler import Sampler
from polars_telemetry.model.types import Query

if TYPE_CHECKING:
    from polars_telemetry.config import Config
    from polars_telemetry.export.base import Exporter

_log = logging.getLogger("polars_telemetry")


class ObserverFactory:
    """Called by polars once per query."""

    __slots__ = ("_config", "_delegate", "_exporter", "_tracker")

    def __init__(
        self,
        config: Config,
        exporter: Exporter,
        delegate: Any | None = None,
    ) -> None:
        """delegate: the real polars-cloud factory, if one was installed."""
        self._config = config
        self._exporter = exporter
        self._delegate = delegate
        self._tracker = FailureTracker("observer")

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
                self._tracker.record(exc)
        return QueryObserver(self._config, self._exporter, self._tracker, delegate)


class QueryObserver:
    """One query's callbacks. Each method is failure-isolated."""

    __slots__ = ("_config", "_delegate", "_exporter", "_plan", "_query_id", "_sampler", "_tracker")

    def __init__(
        self,
        config: Config,
        exporter: Exporter,
        tracker: FailureTracker,
        delegate: Any | None = None,
    ) -> None:
        self._config = config
        self._exporter = exporter
        self._tracker = tracker
        self._delegate = delegate
        self._query_id: UUID = uuid4()
        self._sampler: Sampler | None = None
        self._plan: dict[int, Any] = {}

    def on_query_started(self, query_id: UUID) -> None:
        if not self._tracker.disarmed:
            try:
                self._query_id = query_id
            except Exception as exc:
                self._tracker.record(exc)
        self._forward("on_query_started", query_id)

    def on_query_planned(
        self, query_id: UUID, handle: Any, ir_plan: bytes, physical_plan: bytes
    ) -> ExecutionGuard:
        delegate_guard = self._forward("on_query_planned", query_id, handle, ir_plan, physical_plan)

        if not self._tracker.disarmed:
            try:
                self._query_id = query_id
                self._plan = build_plan(decode_plan(physical_plan))
                self._sampler = Sampler(MetricsHandle(handle), self._config)
                self._sampler.start()
            except Exception as exc:
                self._tracker.record(exc)
                self._sampler = None

        return ExecutionGuard(self, delegate_guard)

    def on_query_failed(self, *args: Any) -> None:
        if not self._tracker.disarmed:
            try:
                self._finish(failure=repr(args) if args else "unknown")
            except Exception as exc:
                self._tracker.record(exc)
        self._forward("on_query_failed", *args)

    def close_query(self) -> None:
        """Called by the guard when polars ends the query."""
        if self._tracker.disarmed:
            return
        try:
            self._finish(failure=None)
        except Exception as exc:
            self._tracker.record(exc)

    def _finish(self, failure: str | None) -> None:
        if self._sampler is None:
            return
        sampler, self._sampler = self._sampler, None
        samples = sampler.stop()
        query = Query(
            query_id=self._query_id,
            wall_ms=sampler.elapsed_ms,
            plan=self._plan,
            samples=samples,
            sample_interval_ms=self._config.effective_interval_ms,
            failed=failure,
        )
        self._exporter.export(query)

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
    """Returned from on_query_planned; polars calls close() at query end.

    close() can fire before the engine's final flush lands, so the closing
    snapshot is reconciled here.
    """

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
