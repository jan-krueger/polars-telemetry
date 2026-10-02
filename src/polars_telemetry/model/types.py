"""Model types."""

from __future__ import annotations

from dataclasses import dataclass, field
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
    """Cumulative counters for one node at the end of the query."""

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

    @property
    def cpu_ms(self) -> float:
        return self.total_time_ns / 1e6

    @property
    def stolen_ratio(self) -> float | None:
        return self.total_stolen_polls / self.total_polls if self.total_polls else None


SINK_KINDS: frozenset[str] = frozenset({"InMemorySink", "IoSink", "PartitionSink"})


@dataclass(frozen=True, slots=True)
class Query:
    """A completed query."""

    query_id: UUID
    wall_ms: float
    plan: dict[int, PlanNode]
    """Physical plan. Node ids here are what metrics key on."""

    logical: dict[int, PlanNode] = field(default_factory=dict)
    """IR plan. Carries the user's own column names; the physical plan rewrites
    group-by keys and aggregations to _POLARS_TMP_N."""

    metrics: dict[int, NodeMetrics] = field(default_factory=dict)
    failed: str | None = None
    started_unix_ns: int = 0

    @property
    def cpu_ms(self) -> float:
        """Summed node self time. Exceeds wall time on a parallel query."""
        return sum(node.total_time_ns for node in self.metrics.values()) / 1e6

    @property
    def parallelism(self) -> float:
        return self.cpu_ms / self.wall_ms if self.wall_ms > 0 else 0.0

    @property
    def result_rows(self) -> int | None:
        """Rows reaching the sink, when the sink reported any."""
        rows = [
            self.metrics[node_id].rows_received
            for node_id, node in self.plan.items()
            if node.kind in SINK_KINDS and node_id in self.metrics
        ]
        return sum(rows) if rows else None

    @property
    def hottest(self) -> tuple[PlanNode, NodeMetrics] | None:
        """The node with the most self time -- usually the whole answer."""
        if not self.metrics:
            return None
        node_id, metric = max(self.metrics.items(), key=lambda item: item[1].total_time_ns)
        node = self.plan.get(node_id)
        return (node, metric) if node is not None else None
