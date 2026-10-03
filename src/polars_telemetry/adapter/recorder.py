"""One query's life, from start to a finished `Query`.

Behind the callback shim in `hook.py`: it knows what to do with a start, a
plan, a failure and a close, and nothing about which polars method delivered
them. A second source of those events — a public observer API, should polars
ship one — would feed the same recorder.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any
from uuid import UUID, uuid4

import polars

from polars_telemetry._callsite import caller
from polars_telemetry.adapter.build import build_metrics, build_plan, enrich
from polars_telemetry.adapter.decode import decode_optional_plan, decode_plan
from polars_telemetry.adapter.handle import MetricsHandle
from polars_telemetry.labels import current_label
from polars_telemetry.model.types import CallSite, NodeRole, PlanNode, Query

if TYPE_CHECKING:
    from collections.abc import Callable

    from polars_telemetry._safety import FailureTracker
    from polars_telemetry.config import Config

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


class QueryRecorder:
    """Assembles one query and hands it to `emit` once, however it ends."""

    __slots__ = (
        "_call_site",
        "_config",
        "_emit",
        "_handle",
        "_label",
        "_logical",
        "_plan",
        "_query_id",
        "_started",
        "_started_unix_ns",
        "_tracker",
    )

    def __init__(
        self, config: Config, emit: Callable[[Query], None], tracker: FailureTracker
    ) -> None:
        self._config = config
        self._emit = emit
        self._tracker = tracker
        self._query_id: UUID = uuid4()
        self._handle: MetricsHandle | None = None
        self._plan: dict[int, PlanNode] = {}
        self._logical: dict[int, PlanNode] = {}
        self._call_site: CallSite | None = None
        self._label: str | None = None
        self._started = 0.0
        self._started_unix_ns = 0

    def started(self, query_id: UUID) -> None:
        # The clock starts here so a query that fails before planning -- a
        # missing column, most commonly -- still produces a span.
        self._query_id = query_id
        self._call_site = caller() if self._config.call_site else None
        self._label = current_label()
        self._started = time.perf_counter()
        self._started_unix_ns = time.time_ns()

    def planned(self, query_id: UUID, ir_plan: bytes, physical_plan: bytes, handle: Any) -> None:
        self._query_id = query_id
        # Each payload on its own: an IR polars has reshaped must cost the IR,
        # not the physical plan, the counters or the span.
        physical = self._plan_from("physical plan", physical_plan, decode_optional_plan)
        logical = self._plan_from("IR plan", ir_plan, decode_plan)
        self._plan = physical or {}
        self._logical = logical or {}
        _report_unknown_kinds(self._plan, self._logical)
        # Counters are keyed by phys_node_key, so without a physical plan there
        # is nothing to attribute them to.
        collect = self._config.node_metrics and physical is not None
        self._handle = MetricsHandle(handle) if collect else None

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
        if self._started == 0.0:
            return
        wall_ms = (time.perf_counter() - self._started) * 1000
        self._started = 0.0

        handle, self._handle = self._handle, None
        if handle is None:
            metrics = {}
        else:
            # A failed query's nodes never report done, so settling would only
            # spend the retry budget inside the caller's exception path.
            records = handle.snapshot() if failure else handle.settled_snapshot()
            metrics = build_metrics(records)

        self._emit(
            enrich(
                Query(
                    query_id=self._query_id,
                    wall_ms=wall_ms,
                    plan=self._plan,
                    logical=self._logical,
                    metrics=metrics,
                    call_site=self._call_site,
                    label=self._label,
                    polars_version=_POLARS_VERSION,
                    failed=failure,
                    started_unix_ns=self._started_unix_ns,
                )
            )
        )
