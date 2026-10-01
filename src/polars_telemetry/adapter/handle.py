"""Wrapper over polars' CloudStreamingMetricsHandle."""

from __future__ import annotations

from typing import Any


class MetricsHandle:
    """Typed surface over snapshot_query_metrics().

    Each call serialises every node's counters, so polling is not free.
    """

    def __init__(self, raw: Any) -> None:
        raise NotImplementedError

    def snapshot(self) -> list[dict[str, Any]]:
        """Current per-node counters; empty list on failure."""
        raise NotImplementedError
