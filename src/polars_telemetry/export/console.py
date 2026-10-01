"""Human-readable output, for debugging and for the walking skeleton.

Useful before any OTel wiring exists, and the quickest way to confirm the hook
is firing in a strange environment.
"""

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
