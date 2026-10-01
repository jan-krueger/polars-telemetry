"""Per-node time windows derived from sampled counters.

polars reports cumulative counters, never timestamps, so windows are inferred
from deltas between samples. Row counters are used, not CPU time:
total_state_update_time_ns advances for every node for the whole query, so a
CPU-derived window spans the full execution for all nodes and carries no
information. Accuracy is bounded by the sampling interval.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Window:
    """Inferred data-flow window, ms from query start."""

    start_ms: float
    end_ms: float
    resolution_ms: float
    """Sampling interval; the error bar on both edges."""


def derive_windows(samples: tuple[object, ...]) -> dict[int, Window]:
    raise NotImplementedError
