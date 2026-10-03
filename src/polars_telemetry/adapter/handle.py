"""Wrapper over polars' CloudStreamingMetricsHandle."""

from __future__ import annotations

import logging
import time
from typing import Any

from polars_telemetry.adapter.decode import decode_metrics

_log = logging.getLogger("polars_telemetry")

# polars can call close() before the engine's final counters settle. Retake the
# snapshot only while nodes still report done=False, rather than always paying
# a fixed delay.
_SETTLE_ATTEMPTS = 5
_SETTLE_WAIT_S = 0.001


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

    def settled_snapshot(self) -> list[dict[str, Any]]:
        """Snapshot once the engine has finished flushing, or near enough."""
        records = self.snapshot()
        for _ in range(_SETTLE_ATTEMPTS):
            if _settled(records):
                return records
            time.sleep(_SETTLE_WAIT_S)
            records = self.snapshot()
        return records


def _settled(records: list[dict[str, Any]]) -> bool:
    """Done, or no way to tell: without a `done` flag -- polars having renamed
    it, say -- retrying would only make every query pay the full budget."""
    if not records or any("done" not in record for record in records):
        return True
    return all(record["done"] for record in records)
