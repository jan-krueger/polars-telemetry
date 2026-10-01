"""Metrics polling for one query."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.adapter.handle import MetricsHandle
    from polars_telemetry.config import Config
    from polars_telemetry.model.types import Sample


class Sampler:
    """Collects samples over a query. One instance per query."""

    def __init__(self, handle: MetricsHandle, config: Config) -> None:
        raise NotImplementedError

    def start(self) -> None:
        """Start the poll thread. Daemon, so an abandoned query cannot keep
        the interpreter alive."""
        raise NotImplementedError

    def stop(self) -> tuple[Sample, ...]:
        """Stop polling, take the closing snapshot, return all samples."""
        raise NotImplementedError
