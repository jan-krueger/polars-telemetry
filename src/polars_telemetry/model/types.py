"""Model types."""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True, slots=True)
class PlanNode:
    """One physical plan node."""

    node_id: int
    """polars' phys_node_key; metrics join on this."""

    kind: str
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


SINK_KINDS: frozenset[str] = frozenset({"InMemorySink", "IoSink", "PartitionSink"})


@dataclass(frozen=True, slots=True)
class Query:
    """A completed query."""

    query_id: UUID
    wall_ms: float
    plan: dict[int, PlanNode]
    samples: tuple[Sample, ...]
    sample_interval_ms: float | None
    failed: str | None = None
    started_unix_ns: int = 0

    @property
    def final(self) -> Sample | None:
        """The closing snapshot, if any metrics were collected at all."""
        return self.samples[-1] if self.samples else None

    @property
    def cpu_ms(self) -> float:
        """Summed node self time. Exceeds wall time on a parallel query."""
        final = self.final
        if final is None:
            return 0.0
        return sum(node.total_time_ns for node in final.nodes.values()) / 1e6

    @property
    def parallelism(self) -> float:
        return self.cpu_ms / self.wall_ms if self.wall_ms > 0 else 0.0

    @property
    def result_rows(self) -> int | None:
        """Rows reaching the sink, when the sink reported any."""
        final = self.final
        if final is None:
            return None
        rows = [
            final.nodes[node_id].rows_received
            for node_id, node in self.plan.items()
            if node.kind in SINK_KINDS and node_id in final.nodes
        ]
        return sum(rows) if rows else None
