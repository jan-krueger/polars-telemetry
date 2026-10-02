"""Per-node time windows derived from sampled counters.

polars reports cumulative counters, never timestamps, so windows are inferred
from deltas between samples. Row counters are used, not CPU time:
total_state_update_time_ns advances for every node for the whole query, so a
CPU-derived window spans the full execution for all nodes and carries no
information. Accuracy is therefore bounded by the sampling interval.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.model.types import Sample


@dataclass(frozen=True, slots=True)
class Window:
    """Inferred data-flow window, ms from query start."""

    start_ms: float
    end_ms: float
    resolution_ms: float
    """Sampling interval; the error bar on both edges."""


def _rows(sample: Sample, node_id: int) -> int:
    node = sample.nodes.get(node_id)
    return 0 if node is None else node.rows_received + node.rows_sent


def derive_windows(samples: tuple[Sample, ...], resolution_ms: float) -> dict[int, Window]:
    """Window each node by when its row counters advanced.

    Needs at least two samples; a single closing snapshot carries no timing.
    """
    if len(samples) < 2:
        return {}

    node_ids = {node_id for sample in samples for node_id in sample.nodes}
    windows: dict[int, Window] = {}

    for node_id in node_ids:
        start: float | None = None
        end: float | None = None
        for previous, current in pairwise(samples):
            if _rows(current, node_id) > _rows(previous, node_id):
                if start is None:
                    start = previous.offset_ms
                end = current.offset_ms
        if start is not None and end is not None:
            windows[node_id] = Window(start_ms=start, end_ms=end, resolution_ms=resolution_ms)
    return windows
