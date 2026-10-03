"""Collect the queries run inside a block of code.

Useful where a global exporter is the wrong shape: a test asserting what a
pipeline did, a notebook cell, or an ad-hoc look at one function.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

from polars_telemetry import _dispatch
from polars_telemetry.activation import acquire_scoped, installed, release_scoped
from polars_telemetry.export.profile import build_profile

if TYPE_CHECKING:
    from collections.abc import Iterator

    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Query


class Session:
    """The queries that ran inside a :func:`profile` block, in order."""

    __slots__ = ("queries",)

    def __init__(self) -> None:
        self.queries: list[Query] = []

    def __len__(self) -> int:
        return len(self.queries)

    def __iter__(self) -> Iterator[Query]:
        return iter(self.queries)

    def __getitem__(self, index: int) -> Query:
        return self.queries[index]

    @property
    def slowest(self) -> Query | None:
        """The query with the longest wall time, or None if none ran."""
        return max(self.queries, key=lambda query: query.wall_ms, default=None)

    @property
    def wall_ms(self) -> float:
        """Summed wall time. Not elapsed time: queries may overlap."""
        return sum(query.wall_ms for query in self.queries)

    def profiles(self) -> list[dict[str, Any]]:
        """The full profile document for each query. Already redacted on
        arrival if the block asked for it."""
        return [build_profile(query) for query in self.queries]

    def write(self, path: str | Path) -> Path:
        """Write a session file the profile viewer can open."""
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as handle:
            for document in self.profiles():
                handle.write(json.dumps(document, separators=(",", ":")) + "\n")
        return target


@contextmanager
def profile(config: Config | None = None) -> Iterator[Session]:
    """Collect every query run inside the block.

    >>> with profile() as session:
    ...     frame.collect()
    >>> session.slowest.call_site

    Composes with an existing installation rather than replacing it: queries
    still reach whatever exporter is already configured, and blocks may nest.
    Instrumentation is installed for the duration only if it was not already.

    The scope is the process, not the thread: a block collects every query that
    completes while it is open, including ones other threads ran.
    """
    held = acquire_scoped(config)
    current = installed()
    # The block's own config wins; otherwise inherit whatever is installed, so
    # a session never hands out literals an installed config would mask.
    effective = config or (current.config if current is not None else None)
    session = Session()
    receiver = _dispatch.add(
        session.queries.append,
        "profile session",
        redact=effective.redact_literals if effective else False,
    )
    try:
        yield session
    finally:
        _dispatch.remove(receiver)
        if held:
            release_scoped()
