"""Deriving per-node time windows from sampled counters.

polars reports cumulative counters, never timestamps, so a node's window has to
be inferred. Two candidates were measured; only one works:

- **CPU deltas are useless.** ``total_state_update_time_ns`` advances for every
  node for the whole query, so a CPU-derived window marks every node as
  spanning the entire execution.
- **Row-counter deltas work.** First and last sample in which ``rows_received``
  or ``rows_sent`` advanced gives a genuine data-flow window, and recovers the
  staggered pipeline shape.

Accuracy is therefore bounded by the sampling interval, and spans carry that
resolution as an attribute so nobody reads them as exact.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Window:
    """A node's inferred data-flow window, in ms from query start."""

    start_ms: float
    end_ms: float
    resolution_ms: float
    """Sampling interval. The error bar on both edges."""


def derive_windows(samples: tuple[object, ...]) -> dict[int, Window]:
    raise NotImplementedError
