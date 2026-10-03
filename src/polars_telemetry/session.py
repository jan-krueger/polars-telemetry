"""Collect the queries run inside a block of code.

Useful where a global exporter is the wrong shape: a test asserting what a
pipeline did, a notebook cell, or an ad-hoc look at one function.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any

from polars_telemetry import _dispatch
from polars_telemetry.activation import acquire_scoped, installed, release_scoped
from polars_telemetry.export.profile import build_profile, profile_line
from polars_telemetry.model.redaction import strictest

if TYPE_CHECKING:
    from collections.abc import Iterator

    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Query


class Session:
    """The queries that ran inside a `profile()` block, in the order they finished.

    Iterate it, index it or take its `len()` like a list of `Query`.
    """

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
        """Each query as a profile document, the format the viewer reads.

        Literals are already masked if the block's config asked for it.
        """
        return [build_profile(query) for query in self.queries]

    def write(self, path: str | Path) -> Path:
        """Write the queries to a `.jsonl` file the viewer can open.

        Args:
            path: Where to write. An existing file is replaced.

        Returns:
            The path written.
        """
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as handle:
            for document in self.profiles():
                handle.write(profile_line(document) + "\n")
        return target


@contextmanager
def profile(config: Config | None = None) -> Iterator[Session]:
    """Collect every query run inside the block.

    Examples:
        >>> with profile() as session:
        ...     frame.collect()
        >>> session.slowest.call_site

    Args:
        config: Used when nothing is installed yet; an existing installation
            keeps its own. The session masks what the installation masks and
            what `config.redaction` adds.

    Queries still reach any exporters already installed, and blocks may nest.
    If nothing was installed, instrumentation is installed for the block and
    removed after it. A block collects every query that finishes while it is
    open, including ones other threads ran.
    """
    held = acquire_scoped(config)
    current = installed()
    session = Session()
    receiver = _dispatch.add(
        session.queries.append,
        "profile session",
        redaction=strictest(
            config.redaction if config else None,
            current.config.redaction if current else None,
        ),
    )
    try:
        yield session
    finally:
        _dispatch.remove(receiver)
        if held is not None:
            release_scoped(held)
