"""Where a finished query goes: every installed exporter and every open session.

One registry under one lock, so the exporters `install()` was given and the
sessions `profile()` opens are the same kind of thing and cannot race each
other. Each receiver has its own failure tracker: an exporter that keeps
raising disarms itself, and the others carry on.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any

from polars_telemetry._safety import FailureTracker
from polars_telemetry.model.redaction import URL_QUERIES, Redaction, redact_query

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from polars_telemetry.model.types import Progress, Query


class Receiver:
    """A registered destination. Keep it: removal is by this object.

    `started` and `progress` are for destinations that follow queries while
    they run; most have neither.
    """

    __slots__ = ("progress", "receive", "redaction", "started", "tracker")

    def __init__(
        self,
        receive: Callable[[Query], None],
        label: str,
        *,
        redaction: Redaction | None,
        started: Callable[[Query], None] | None = None,
        progress: Callable[[Progress], None] | None = None,
    ) -> None:
        self.receive = receive
        self.redaction = redaction
        self.started = started
        self.progress = progress
        self.tracker = FailureTracker(label)


_lock = threading.Lock()
_receivers: tuple[Receiver, ...] = ()


def add(
    receive: Callable[[Query], None],
    label: str,
    *,
    redaction: Redaction | None = None,
    started: Callable[[Query], None] | None = None,
    progress: Callable[[Progress], None] | None = None,
) -> Receiver:
    """Register a destination, which receives queries masked by `redaction`."""
    global _receivers
    receiver = Receiver(receive, label, redaction=redaction, started=started, progress=progress)
    with _lock:
        _receivers = (*_receivers, receiver)
    return receiver


def remove(receiver: Receiver) -> None:
    global _receivers
    with _lock:
        _receivers = tuple(r for r in _receivers if r is not receiver)


def dispatch(query: Query) -> None:
    """Hand the finished query to every receiver. Never raises.

    The tuple is swapped whole under the lock, so iterating the reference read
    here needs none.
    """
    _deliver(query, "receive")


def dispatch_started(query: Query) -> None:
    """Announce a query still running at its first sample, with its plan."""
    _deliver(query, "started")


def dispatch_progress(progress: Progress) -> None:
    """Hand a sample to every receiver that follows running queries.

    Counters carry no literals, so there is nothing to mask.
    """
    for receiver, handler in _handlers("progress"):
        try:
            handler(progress)
        except Exception as exc:
            receiver.tracker.record(exc)


def wants_progress() -> bool:
    """Whether any receiver follows running queries, so sampling is worth it."""
    return any(_handlers("started")) or any(_handlers("progress"))


def _handlers(name: str) -> Iterator[tuple[Receiver, Callable[[Any], None]]]:
    for receiver in _receivers:
        handler = getattr(receiver, name)
        if handler is not None and not receiver.tracker.disarmed:
            yield receiver, handler


def _deliver(query: Query, name: str) -> None:
    masked: dict[Redaction, Query] = {}
    for receiver, handler in _handlers(name):
        try:
            redaction = receiver.redaction or URL_QUERIES
            # Once per redaction per query, however many receivers share it.
            # Should masking raise, the receiver gets nothing rather than the
            # unmasked query: this fails closed.
            if redaction not in masked:
                masked[redaction] = redact_query(query, redaction)
            handler(masked[redaction])
        except Exception as exc:
            receiver.tracker.record(exc)
