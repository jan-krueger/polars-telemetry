"""Human-readable exporter, for debugging without OTel wiring."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, TextIO

if TYPE_CHECKING:
    from polars_telemetry.model.types import Query


class ConsoleExporter:
    """Prints one summary block per query."""

    def __init__(self, stream: TextIO = sys.stderr) -> None:
        raise NotImplementedError

    def export(self, query: Query) -> None:
        raise NotImplementedError
