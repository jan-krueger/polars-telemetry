"""Naming the queries a block of code runs, so they can be found again.

A label is set by the application and read back when a query starts; nothing
of polars is involved. Nested labels join into a path, so `label("etl")`
around `label("customers")` names its queries `etl/customers`.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

SEPARATOR = "/"

_path: ContextVar[tuple[str, ...]] = ContextVar("polars_telemetry_label", default=())


@contextmanager
def label(name: str) -> Iterator[None]:
    """Label every query run inside the block.

    Examples:
        >>> with label("etl"), label("customers"):
        ...     frame.collect()  # labelled "etl/customers"

    Args:
        name: Any non-empty text. Nested labels are joined with `/`.

    Raises:
        ValueError: If `name` is empty or not a string.

    The label goes on the query's span as `polars.query.label` and into its
    profile, but never onto metrics: free-form values would make unbounded
    metric series. Each thread has its own labels. Queries run with
    `collect_async()` or `collect_batches()` carry none: polars reports those
    from its own threads.
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
