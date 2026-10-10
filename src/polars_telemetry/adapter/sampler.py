"""Samples of running queries, taken on one background thread.

polars hands each query a metrics handle when it is planned; the counters
behind it grow while the query runs. Sampling it every so often is all a live
view needs. One thread serves every query in the process, and it only runs
while some exporter follows running queries.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from polars_telemetry.adapter.build import build_metrics
from polars_telemetry.model.types import Progress

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from polars_telemetry.adapter.handle import MetricsHandle
    from polars_telemetry.model.types import NodeMetrics

_log = logging.getLogger("polars_telemetry")


@dataclass(slots=True)
class _Watch:
    query_id: UUID
    handle: MetricsHandle
    started: float
    interval: float
    announce: Callable[[], None]
    deliver: Callable[[Progress], None]
    due: float
    announced: bool = False
    previous: dict[int, NodeMetrics] = field(default_factory=dict)


class Sampler:
    """Samples every watched query at a fixed interval.

    A query is announced at its first sample, so one that ends sooner is never
    reported as running. `unwatch` waits for a sample in progress, so nothing
    about a query is delivered after it.
    """

    def __init__(self, clock: Callable[[], float] = time.perf_counter) -> None:
        self._clock = clock
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
        with self._cond:
            self._watches.pop(query_id, None)
            while self._busy == query_id:
                self._cond.wait()

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
        metrics = build_metrics(watch.handle.snapshot())
        if not metrics:
            return
        first = not watch.announced
        if first:
            watch.announced = True
            watch.announce()
        changed = {
            node_id: metric
            for node_id, metric in metrics.items()
            if first or watch.previous.get(node_id) != metric
        }
        watch.previous = metrics
        if changed:
            elapsed_ms = (self._clock() - watch.started) * 1000
            watch.deliver(Progress(watch.query_id, elapsed_ms, changed))


SAMPLER = Sampler()
"""The process's one sampler."""
