"""Wrapper over polars' CloudStreamingMetricsHandle."""

from __future__ import annotations

import logging
from typing import Any

from polars_telemetry.adapter.decode import decode_metrics

_log = logging.getLogger("polars_telemetry")


class MetricsHandle:
    """Typed surface over snapshot_query_metrics().

    Each call serialises every node's counters, so polling is not free.
    """

    __slots__ = ("_failures", "_raw")

    def __init__(self, raw: Any) -> None:
        self._raw = raw
        self._failures = 0

    def snapshot(self) -> list[dict[str, Any]]:
        """Current per-node counters; empty list on failure."""
        try:
            return decode_metrics(self._raw.snapshot_query_metrics())
        except Exception as exc:
            self._failures += 1
            if self._failures == 1:
                _log.warning(
                    "polars-telemetry: metrics snapshot failed (%s: %s)",
                    type(exc).__name__,
                    exc,
                )
            return []

    @property
    def failures(self) -> int:
        return self._failures
