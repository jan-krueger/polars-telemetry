"""Exporter interface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from polars_telemetry.model.redaction import redact_query

if TYPE_CHECKING:
    from polars_telemetry.model.redaction import Redaction
    from polars_telemetry.model.types import Query


class Exporter(Protocol):
    """Anything with an `export(query)` method can receive queries.

    An exporter that holds data, such as a buffer, may also have a `close()`
    method. `uninstall()` calls it, and so does the process on exit.

    To follow queries while they run, an exporter may also have
    `started(query)`, called with the plan at a query's first sample, and
    `progress(progress)`, called at every sample after it. Both run on a
    background thread, and never after the query's `export()`.
    """

    def export(self, query: Query) -> None:
        """Handle one finished query.

        Called on the thread that ran the query, once per query, after it has
        finished, so the time spent here is added to the caller's. An exception
        is logged and counted; after five, this exporter stops receiving
        queries and the others carry on.
        """


@dataclass(frozen=True)
class Redacted:
    """An exporter with a redaction of its own. Made by `redacted()`."""

    exporter: Exporter
    redaction: Redaction | None

    def export(self, query: Query) -> None:
        """Mask the query, then hand it on. `install()` masks before calling
        the exporter itself, so this is only for calling it directly."""
        masked = redact_query(query, self.redaction) if self.redaction is not None else query
        self.exporter.export(masked)


def redacted(exporter: Exporter, redaction: Redaction | None) -> Redacted:
    """Give one exporter its own redaction, in place of `Config.redaction`.

    Examples:
        >>> polars_telemetry.install(
        ...     Config(redaction=Redaction()),
        ...     exporter=[
        ...         redacted(OTelExporter(config), Redaction(paths=True, call_site=True)),
        ...         redacted(FileExporter("profiles/full.jsonl"), None),
        ...     ],
        ... )

    Args:
        exporter: Any exporter.
        redaction: What to mask for this exporter; None sends it everything
            but URL query strings, whatever `Config.redaction` says.

    Returns:
        The exporter, to pass to `install()`.
    """
    return Redacted(exporter, redaction)
