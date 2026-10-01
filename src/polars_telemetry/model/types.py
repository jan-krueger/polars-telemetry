"""The shapes the rest of the package works in."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True, slots=True)
class PlanNode:
    """One physical plan node."""

    node_id: int
    """polars' ``phys_node_key``; metrics join on this."""

    kind: str
    """``MultiScan``, ``EquiJoin``, ``GroupBy``, ``Sort``, ..."""

    inputs: tuple[int, ...]
    properties: dict[str, object]
    """Raw plan properties: scan source, predicate, join keys, aggregations."""


@dataclass(frozen=True, slots=True)
class NodeMetrics:
    """Counters for one node at one instant. Cumulative, not deltas."""

    node_id: int
    total_time_ns: int
    total_polls: int
    total_stolen_polls: int
    max_poll_time_ns: int
    total_state_updates: int
    rows_received: int
    rows_sent: int
    morsels_received: int
    morsels_sent: int
    largest_morsel_received: int
    largest_morsel_sent: int
    io_total_active_ns: int
    io_total_bytes_received: int
    io_total_bytes_requested: int
    io_total_bytes_sent: int
    done: bool


@dataclass(frozen=True, slots=True)
class Sample:
    """All nodes' counters at one offset from query start."""

    offset_ms: float
    nodes: dict[int, NodeMetrics]


@dataclass(frozen=True, slots=True)
class Query:
    """A complete observed query."""

    query_id: UUID
    wall_ms: float
    plan: dict[int, PlanNode]
    samples: tuple[Sample, ...]
    sample_interval_ms: float | None
    failed: str | None = None
