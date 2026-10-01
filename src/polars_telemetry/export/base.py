"""Exporter interface."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from polars_telemetry.model.types import Query


class Exporter(Protocol):
    """Receives a completed query. Must not raise."""

    def export(self, query: Query) -> None: ...
