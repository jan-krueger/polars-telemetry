"""Wrapper over polars' ``CloudStreamingMetricsHandle``.

The handle exposes a single method, ``snapshot_query_metrics() -> bytes``,
callable at any point during execution. Polling it is what makes per-node
timelines possible; it is also not free, since each call serialises every
node's counters.
"""

from __future__ import annotations

from typing import Any


class MetricsHandle:
    """Isolates the one foreign method call behind a typed surface."""

    def __init__(self, raw: Any) -> None:
        raise NotImplementedError

    def snapshot(self) -> list[dict[str, Any]]:
        """Read current per-node counters. Returns an empty list on failure."""
        raise NotImplementedError
