"""Extra receivers for completed queries, alongside the installed exporter.

Scoped profiling registers here rather than replacing the exporter, so it
composes with whatever an application already installed and can nest.
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

    from polars_telemetry.model.types import Query

_log = logging.getLogger("polars_telemetry")

_lock = threading.Lock()
_sinks: tuple[Callable[[Query], None], ...] = ()


def add(sink: Callable[[Query], None]) -> None:
    global _sinks
    with _lock:
        _sinks = (*_sinks, sink)


def discard(sink: Callable[[Query], None]) -> None:
    global _sinks
    with _lock:
        _sinks = tuple(existing for existing in _sinks if existing is not sink)


def active() -> bool:
    return bool(_sinks)


def dispatch(query: Query) -> None:
    """Hand the query to every registered sink. Never raises.

    A failing sink is isolated: it must not cost the caller their telemetry,
    nor the other sinks theirs.
    """
    for sink in _sinks:
        try:
            sink(query)
        except Exception:
            _log.warning("polars-telemetry: a profile sink failed", exc_info=True)
