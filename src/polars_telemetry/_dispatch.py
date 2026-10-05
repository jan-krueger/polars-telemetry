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
from polars_telemetry.model.redaction import URL_QUERIES, Redaction, redact_query

if TYPE_CHECKING:
    from collections.abc import Callable

    from polars_telemetry.model.types import Query


class Receiver:
    """A registered destination. Keep it: removal is by this object."""

    __slots__ = ("receive", "redaction", "tracker")

    def __init__(
        self, receive: Callable[[Query], None], label: str, *, redaction: Redaction | None
    ) -> None:
        self.receive = receive
        self.redaction = redaction
        self.tracker = FailureTracker(label)


_lock = threading.Lock()
_receivers: tuple[Receiver, ...] = ()


def add(
    receive: Callable[[Query], None], label: str, *, redaction: Redaction | None = None
) -> Receiver:
    """Register a destination, which receives queries masked by `redaction`."""
    global _receivers
    receiver = Receiver(receive, label, redaction=redaction)
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
    masked: dict[Redaction, Query] = {}
    for receiver in _receivers:
        if receiver.tracker.disarmed:
            continue
        try:
            redaction = receiver.redaction or URL_QUERIES
            # Once per redaction per query, however many receivers share it.
            # Should masking raise, the receiver gets nothing rather than the
            # unmasked query: this fails closed.
            if redaction not in masked:
                masked[redaction] = redact_query(query, redaction)
            delivered = masked[redaction]
            receiver.receive(delivered)
        except Exception as exc:
            receiver.tracker.record(exc)
