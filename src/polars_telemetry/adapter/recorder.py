"""One query's life, from start to a finished `Query`.

Behind the callback shim in `hook.py`: it knows what to do with a start, a
plan, a failure and a close, and nothing about which polars method delivered
them. A second source of those events — a public observer API, should polars
ship one — would feed the same recorder.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

import polars

from polars_telemetry._callsite import caller
from polars_telemetry.adapter.build import build_metrics, build_plan, enrich
from polars_telemetry.adapter.decode import decode_optional_plan, decode_plan, is_nil
from polars_telemetry.adapter.handle import MetricsHandle
from polars_telemetry.adapter.sampler import SAMPLER
from polars_telemetry.labels import current_label
from polars_telemetry.model.types import CallSite, NodeRole, PlanNode, Query

if TYPE_CHECKING:
    from collections.abc import Callable

    from polars_telemetry._safety import FailureTracker
    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Progress

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


@dataclass(frozen=True, slots=True)
class Follow:
    """Where running queries go, for exporters that follow them."""

    wanted: Callable[[], bool]
    started: Callable[[Query], None]
    progress: Callable[[Progress], None]


@dataclass(slots=True)
class _Run:
    """One query in flight: what its start and plan delivered so far."""

    query_id: UUID = field(default_factory=uuid4)
    started: float = 0.0
    started_unix_ns: int = 0
    call_site: CallSite | None = None
    label: str | None = None
    engine: str | None = None
    plan: dict[int, PlanNode] = field(default_factory=dict)
    logical: dict[int, PlanNode] = field(default_factory=dict)
    handle: MetricsHandle | None = None
    planning_ms: float | None = None
    telemetry_ms: float | None = None


class QueryRecorder:
    """Assembles each query and hands it to `emit` once, however it ends.

    polars can give one observer several queries, even at the same time from
    different threads. A query delivers all its callbacks on one thread, so
    each thread's query is kept apart.
    """

    __slots__ = ("_config", "_emit", "_follow", "_lock", "_runs", "_tracker")

    def __init__(
        self,
        config: Config,
        emit: Callable[[Query], None],
        tracker: FailureTracker,
        follow: Follow | None = None,
    ) -> None:
        self._config = config
        self._emit = emit
        self._tracker = tracker
        self._follow = follow
        self._runs: dict[int, _Run] = {}
        self._lock = threading.Lock()

    def _current(self, *, finishing: bool = False) -> _Run | None:
        """This thread's query; the only one in flight if this thread has none."""
        thread = threading.get_ident()
        with self._lock:
            run = self._runs.get(thread)
            if run is None and len(self._runs) == 1:
                thread, run = next(iter(self._runs.items()))
            if run is not None and finishing:
                del self._runs[thread]
            return run

    def started(self, query_id: UUID) -> None:
        # The clock starts here so a query that fails before planning -- a
        # missing column, most commonly -- still produces a span.
        run = _Run(
            query_id=query_id,
            started=time.perf_counter(),
            started_unix_ns=time.time_ns(),
            call_site=caller() if self._config.call_site else None,
            label=current_label(),
        )
        with self._lock:
            self._runs[threading.get_ident()] = run

    def planned(self, query_id: UUID, ir_plan: bytes, physical_plan: bytes, handle: Any) -> None:
        arrived = time.perf_counter()
        run = self._current()
        if run is None:
            return
        if run.started:
            run.planning_ms = (arrived - run.started) * 1000
        try:
            self._planned(run, query_id, ir_plan, physical_plan, handle)
        finally:
            run.telemetry_ms = (time.perf_counter() - arrived) * 1000

    def _planned(
        self, run: _Run, query_id: UUID, ir_plan: bytes, physical_plan: bytes, handle: Any
    ) -> None:
        run.query_id = query_id
        # Monitoring sets the affinity to streaming, but an explicit engine= or
        # an eager operation overrides it, and polars then sends no physical plan.
        run.engine = "in-memory" if is_nil(physical_plan) else "streaming"
        # Each payload on its own: an IR polars has reshaped must cost the IR,
        # not the physical plan, the counters or the span.
        physical = self._plan_from("physical plan", physical_plan, decode_optional_plan)
        logical = self._plan_from("IR plan", ir_plan, decode_plan)
        run.plan = physical or {}
        run.logical = logical or {}
        _report_unknown_kinds(run.plan, run.logical)
        # Counters are keyed by phys_node_key, so without a physical plan there
        # is nothing to attribute them to.
        collect = self._config.node_metrics and physical is not None
        run.handle = MetricsHandle(handle) if collect else None
        follow = self._follow
        if run.handle is not None and follow is not None and follow.wanted():
            SAMPLER.watch(
                run.query_id,
                run.handle,
                started=run.started,
                interval=self._config.progress_interval,
                announce=lambda: follow.started(self._running(run)),
                deliver=follow.progress,
            )

    def failed(self, message: str) -> None:
        self._finish(failure=message)

    def closed(self) -> None:
        self._finish(failure=None)

    def _plan_from(
        self,
        what: str,
        payload: bytes,
        decode: Callable[[bytes], list[dict[str, Any]] | None],
    ) -> dict[int, PlanNode] | None:
        """A built plan, or None when polars sent none or one we cannot read."""
        try:
            records = decode(payload)
            return None if records is None else build_plan(records)
        except Exception as exc:
            self._tracker.note(exc, what)
            return None

    def _finish(self, failure: str | None) -> None:
        # polars can deliver both a failure and a close; the first one wins.
        run = self._current(finishing=True)
        if run is None or run.started == 0.0:
            return
        wall_ms = (time.perf_counter() - run.started) * 1000

        if run.handle is None:
            metrics = {}
        else:
            SAMPLER.unwatch(run.query_id)
            # A failed query's nodes never report done, so settling would only
            # spend the retry budget inside the caller's exception path.
            records = run.handle.snapshot() if failure else run.handle.settled_snapshot()
            metrics = build_metrics(records)

        self._emit(
            enrich(
                Query(
                    query_id=run.query_id,
                    wall_ms=wall_ms,
                    plan=run.plan,
                    logical=run.logical,
                    metrics=metrics,
                    call_site=run.call_site,
                    label=run.label,
                    engine=run.engine,
                    polars_version=_POLARS_VERSION,
                    failed=failure,
                    started_unix_ns=run.started_unix_ns,
                    planning_ms=run.planning_ms,
                    telemetry_ms=run.telemetry_ms,
                ),
                insights=self._config.insights,
            )
        )

    def _running(self, run: _Run) -> Query:
        """The query as known at its first sample: its plan, not yet its counters."""
        return enrich(
            Query(
                query_id=run.query_id,
                wall_ms=(time.perf_counter() - run.started) * 1000,
                plan=run.plan,
                logical=run.logical,
                metrics={},
                call_site=run.call_site,
                label=run.label,
                engine=run.engine,
                polars_version=_POLARS_VERSION,
                started_unix_ns=run.started_unix_ns,
                planning_ms=run.planning_ms,
                telemetry_ms=run.telemetry_ms,
            )
        )
