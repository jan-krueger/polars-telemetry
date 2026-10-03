"""Exporter interface."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from polars_telemetry.model.types import Query


class Exporter(Protocol):
    """Anything with an `export(query)` method can receive queries."""

    def export(self, query: Query) -> None:
        """Handle one finished query.

        Called on the thread that ran the query, once per query, after it has
        finished, so the time spent here is added to the caller's. An exception
        is logged and counted; after five, this exporter stops receiving
        queries and the others carry on.
        """
