"""Naming the queries a block of code runs, so they can be found again.

A label is set by the application and read back when a query starts; nothing
of polars is involved. Nested labels join into a path, so ``label("etl")``
around ``label("customers")`` names its queries ``etl/customers``.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

SEPARATOR = "/"

# A context variable rather than a global: concurrent threads and asyncio tasks
# each see their own labels. polars runs the observer on the thread that called
# collect(), so the label in force there is the one recorded.
_path: ContextVar[tuple[str, ...]] = ContextVar("polars_telemetry_label", default=())


@contextmanager
def label(name: str) -> Iterator[None]:
    """Label every query run inside the block.

    >>> with label("daily_report"):
    ...     frame.collect()

    The label is recorded on the query's span and in its profile. It is not a
    metric dimension: it is free-form, so it could carry unbounded values.
    """
    if not isinstance(name, str) or not name.strip():
        msg = "a label must be a non-empty string"
        raise ValueError(msg)
    token = _path.set((*_path.get(), name.strip()))
    try:
        yield
    finally:
        _path.reset(token)


def current_label() -> str | None:
    """The label in force here, nested labels joined; None outside any."""
    parts = _path.get()
    return SEPARATOR.join(parts) if parts else None
