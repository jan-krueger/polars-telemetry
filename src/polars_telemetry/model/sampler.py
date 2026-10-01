"""Owns the polling thread, if there is one.

One sampler per query. Threads are daemon threads so an abandoned query cannot
keep the interpreter alive, and the final snapshot is taken after the poll loop
stops -- the engine's last flush can land after ``close`` is called.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.adapter.handle import MetricsHandle
    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Sample


class Sampler:
    """Collects :class:`~polars_telemetry.model.types.Sample` over a query."""

    def __init__(self, handle: MetricsHandle, config: Config) -> None:
        raise NotImplementedError

    def start(self) -> None:
        raise NotImplementedError

    def stop(self) -> tuple[Sample, ...]:
        """Halt polling, take the closing snapshot, return everything."""
        raise NotImplementedError
