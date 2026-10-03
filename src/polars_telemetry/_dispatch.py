"""Where a finished query goes: every installed exporter and every open session.

One registry under one lock, so the exporters `install()` was given and the
sessions `profile()` opens are the same kind of thing and cannot race each
other. Each receiver has its own failure tracker: an exporter that keeps
raising disarms itself, and the others carry on.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

from polars_telemetry._safety import FailureTracker
from polars_telemetry.model.redaction import redact_query

if TYPE_CHECKING:
    from collections.abc import Callable

    from polars_telemetry.model.types import Query


class Receiver:
    """A registered destination. Keep it: removal is by this object."""

    __slots__ = ("receive", "redact", "tracker")

    def __init__(self, receive: Callable[[Query], None], label: str, *, redact: bool) -> None:
        self.receive = receive
        self.redact = redact
        self.tracker = FailureTracker(label)


_lock = threading.Lock()
_receivers: tuple[Receiver, ...] = ()


def add(receive: Callable[[Query], None], label: str, *, redact: bool = False) -> Receiver:
    """Register a destination. `redact`: it receives queries with literals masked."""
    global _receivers
    receiver = Receiver(receive, label, redact=redact)
    with _lock:
        _receivers = (*_receivers, receiver)
    return receiver


def remove(receiver: Receiver) -> None:
    global _receivers
    with _lock:
        _receivers = tuple(r for r in _receivers if r is not receiver)


def dispatch(query: Query) -> None:
    """Hand the query to every receiver. Never raises.

    The tuple is swapped whole under the lock, so iterating the reference read
    here needs none.
    """
    redacted: Query | None = None
    for receiver in _receivers:
        if receiver.tracker.disarmed:
            continue
        try:
            delivered = query
            if receiver.redact:
                # Once per query, however many receivers asked for it. Should
                # redaction raise, the receiver gets nothing rather than the
                # unredacted query: this fails closed.
                if redacted is None:
                    redacted = redact_query(query)
                delivered = redacted
            receiver.receive(delivered)
        except Exception as exc:
            receiver.tracker.record(exc)
