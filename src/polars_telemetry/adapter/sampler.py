"""Samples of running queries, taken on one background thread.

polars hands each query a metrics handle when it is planned; the counters
behind it grow while the query runs. Sampling it every so often is all a live
view needs. One thread serves every query in the process; it starts with the
first query some exporter follows.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from polars_telemetry.adapter.build import build_metrics
from polars_telemetry.model.types import Progress

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from polars_telemetry.adapter.handle import MetricsHandle

_log = logging.getLogger("polars_telemetry")

_UNWATCH_WAIT = 5.0


@dataclass(slots=True)
class _Watch:
    query_id: UUID
    handle: MetricsHandle
    started: float
    interval: float
    announce: Callable[[], None] | None
    deliver: Callable[[Progress], None]
    due: float
    previous: dict[Any, dict[str, Any]] = field(default_factory=dict)


class Sampler:
    """Samples every watched query at a fixed interval.

    A query is announced at its first sample, so one that ends sooner is never
    reported as running. `unwatch` waits for a sample in progress, so nothing
    about a query is delivered after it.
    """

    def __init__(self, clock: Callable[[], float] = time.perf_counter) -> None:
        self._clock = clock
        self._reset()

    def _reset(self) -> None:
        self._cond = threading.Condition()
        self._watches: dict[UUID, _Watch] = {}
        self._busy: UUID | None = None
        self._thread: threading.Thread | None = None
        self._failures = 0

    def watch(
        self,
        query_id: UUID,
        handle: MetricsHandle,
        *,
        started: float,
        interval: float,
        announce: Callable[[], None],
        deliver: Callable[[Progress], None],
    ) -> None:
        with self._cond:
            self._watches[query_id] = _Watch(
                query_id, handle, started, interval, announce, deliver, due=started + interval
            )
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(
                    target=self._run, name="polars-telemetry-sampler", daemon=True
                )
                self._thread.start()
            self._cond.notify_all()

    def unwatch(self, query_id: UUID) -> None:
        deadline = time.monotonic() + _UNWATCH_WAIT
        with self._cond:
            self._watches.pop(query_id, None)
            while self._busy == query_id and not sys.is_finalizing():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return
                self._cond.wait(remaining)

    def _next(self) -> _Watch:
        with self._cond:
            while True:
                if not self._watches:
                    self._cond.wait()
                    continue
                watch = min(self._watches.values(), key=lambda w: w.due)
                wait = watch.due - self._clock()
                if wait <= 0:
                    self._busy = watch.query_id
                    return watch
                self._cond.wait(wait)

    def _run(self) -> None:
        while True:
            watch = self._next()
            try:
                self._sample(watch)
            except Exception as exc:
                self._failures += 1
                if self._failures == 1:
                    _log.warning(
                        "polars-telemetry: sampling a running query failed (%s: %s). "
                        "Queries are unaffected.",
                        type(exc).__name__,
                        exc,
                    )
            finally:
                with self._cond:
                    self._busy = None
                    watch.due = self._clock() + watch.interval
                    self._cond.notify_all()

    def _sample(self, watch: _Watch) -> None:
        records = watch.handle.snapshot()
        if not records:
            return
        if watch.announce is not None:
            announce, watch.announce = watch.announce, None
            announce()
        changed = [r for r in records if watch.previous.get(r.get("phys_node_key")) != r]
        watch.previous = {r.get("phys_node_key"): r for r in records}
        if changed:
            elapsed_ms = (self._clock() - watch.started) * 1000
            watch.deliver(Progress(watch.query_id, elapsed_ms, build_metrics(changed)))


SAMPLER = Sampler()
"""The process's one sampler."""

if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=SAMPLER._reset)
