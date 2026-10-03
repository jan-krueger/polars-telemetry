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
import time
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

import polars

from polars_telemetry import _sinks
from polars_telemetry._callsite import caller
from polars_telemetry._safety import FailureTracker
from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.adapter.decode import decode_optional_plan, decode_plan
from polars_telemetry.adapter.handle import MetricsHandle
from polars_telemetry.model.types import CallSite, NodeRole, PlanNode, Query

if TYPE_CHECKING:
    from collections.abc import Callable

    from polars_telemetry.config import Config
    from polars_telemetry.export.base import Exporter

_log = logging.getLogger("polars_telemetry")

# The adapter is the layer that knows polars; everything downstream reads the
# version off the Query.
_POLARS_VERSION: str = str(getattr(polars, "__version__", "unknown"))


_reported_kinds: set[str] = set()


def _report_unknown_kinds(*plans: dict[int, PlanNode]) -> None:
    """Warn once per kind the dialect does not recognise.

    A renamed operator would otherwise just make attributes and diagnostics
    that depended on its role disappear, with nothing said anywhere.
    """
    for plan in plans:
        for node in plan.values():
            if node.role is NodeRole.UNKNOWN and node.kind not in _reported_kinds:
                _reported_kinds.add(node.kind)
                _log.warning(
                    "polars-telemetry: polars sent a plan node of kind %r, which this "
                    "version does not recognise; attributes that depend on it will be "
                    "missing.",
                    node.kind,
                )


def _message(args: tuple[Any, ...]) -> str:
    """The failure text polars passed, whatever position it arrived in."""
    for arg in args:
        if isinstance(arg, str) and arg:
            return arg
    return "unknown"


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

    __slots__ = (
        "_call_site",
        "_config",
        "_delegate",
        "_exporter",
        "_handle",
        "_logical",
        "_plan",
        "_query_id",
        "_started",
        "_started_unix_ns",
        "_tracker",
    )

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
        self._handle: MetricsHandle | None = None
        self._plan: dict[int, Any] = {}
        self._logical: dict[int, Any] = {}
        self._call_site: CallSite | None = None
        self._started = 0.0
        self._started_unix_ns = 0

    def on_query_started(self, query_id: UUID) -> None:
        if not self._tracker.disarmed:
            try:
                self._query_id = query_id
                self._call_site = caller() if self._config.call_site else None
                self._started = time.perf_counter()
                self._started_unix_ns = time.time_ns()
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
                # Each payload on its own: an IR polars has reshaped must cost
                # the IR, not the physical plan, the counters or the span.
                physical = self._plan_from("physical plan", physical_plan, decode_optional_plan)
                logical = self._plan_from("IR plan", ir_plan, decode_plan)
                self._plan = physical or {}
                self._logical = logical or {}
                _report_unknown_kinds(self._plan, self._logical)
                # Counters are keyed by phys_node_key, so without a physical
                # plan there is nothing to attribute them to.
                collect_metrics = self._config.node_metrics and physical is not None
                self._handle = MetricsHandle(handle) if collect_metrics else None
            except Exception as exc:
                self._tracker.record(exc)
                self._handle = None

        return ExecutionGuard(self, delegate_guard)

    def _plan_from(
        self,
        what: str,
        payload: bytes,
        decode: Callable[[bytes], list[dict[str, Any]] | None],
    ) -> dict[int, Any] | None:
        """A built plan, or None when polars sent none or one we cannot read."""
        try:
            records = decode(payload)
            return None if records is None else build_plan(records)
        except Exception as exc:
            self._tracker.note(exc, what)
            return None

    def on_query_failed(self, *args: Any) -> None:
        if not self._tracker.disarmed:
            try:
                self._finish(failure=_message(args))
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
        if self._started == 0.0:
            return
        wall_ms = (time.perf_counter() - self._started) * 1000
        self._started = 0.0

        handle, self._handle = self._handle, None
        metrics = build_metrics(handle.settled_snapshot()) if handle is not None else {}

        query = Query(
            query_id=self._query_id,
            wall_ms=wall_ms,
            plan=self._plan,
            logical=self._logical,
            metrics=metrics,
            call_site=self._call_site,
            failed=failure,
            started_unix_ns=self._started_unix_ns,
        )
        self._exporter.export(query)
        if _sinks.active():
            _sinks.dispatch(query)

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
