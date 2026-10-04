"""A query's plan, indexed once for every rule to ask questions of."""

from __future__ import annotations

from functools import cached_property
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.model.types import NodeMetrics, PlanNode, Query


class PlanView:
    """Read-only answers about the physical plan; rules never walk it themselves."""

    def __init__(self, query: Query) -> None:
        self.query = query
        self._total_ns = sum(m.total_time_ns for m in query.metrics.values())
        self._wall_ns = query.wall_ms * 1e6

    @cached_property
    def _consumers(self) -> dict[int, tuple[int, ...]]:
        consumers: dict[int, list[int]] = {}
        for node in self.query.plan.values():
            for input_id in node.inputs:
                consumers.setdefault(input_id, []).append(node.node_id)
        return {node_id: tuple(ids) for node_id, ids in consumers.items()}

    @cached_property
    def asks_for_deduplication(self) -> bool:
        """The query's own plan asks to remove duplicates somewhere.

        polars also deduplicates internally, for n_unique for one; on the physical
        plan the two look alike.
        """
        return any(
            n.traits.deduplicates or n.traits.asks_unique for n in self.query.logical.values()
        )

    def inputs(self, node: PlanNode) -> tuple[PlanNode, ...]:
        return tuple(self.query.plan[i] for i in node.inputs if i in self.query.plan)

    def consumers(self, node: PlanNode) -> tuple[PlanNode, ...]:
        return tuple(self.query.plan[i] for i in self._consumers.get(node.node_id, ()))

    def metrics(self, node: PlanNode) -> NodeMetrics | None:
        return self.query.metrics.get(node.node_id)

    def rows_sent(self, node: PlanNode) -> int | None:
        metric = self.metrics(node)
        return None if metric is None else metric.rows_sent

    def rows_delivered(self, source: PlanNode) -> float | None:
        """Rows one consumer receives: a node feeding several counts each copy it sends."""
        sent = self.rows_sent(source)
        return None if sent is None else sent / max(1, len(self._consumers.get(source.node_id, ())))

    def larger_input_rows(self, node: PlanNode) -> float | None:
        delivered = [
            rows for i in self.inputs(node) if (rows := self.rows_delivered(i)) is not None
        ]
        return max(delivered) if delivered else None

    def carriers(self, node: PlanNode, rows: float) -> tuple[PlanNode, ...]:
        """Nodes downstream that receive at least `rows`, up to the first that shrinks them."""
        found: dict[int, PlanNode] = {}
        frontier = [node]
        while frontier:
            for consumer in self.consumers(frontier.pop()):
                if consumer.node_id in found:
                    continue
                found[consumer.node_id] = consumer
                if (self.rows_sent(consumer) or 0) >= rows:
                    frontier.append(consumer)
        return tuple(found.values())

    def cpu_share(self, *nodes: PlanNode) -> float:
        if not self._total_ns:
            return 0.0
        spent = sum(m.total_time_ns for n in nodes if (m := self.metrics(n)) is not None)
        return spent / self._total_ns

    def blocked_share(self, node: PlanNode) -> float:
        """The node's longest single step as a share of wall time: time the pipeline waited."""
        metric = self.metrics(node)
        if metric is None or self._wall_ns <= 0:
            return 0.0
        return min(
            1.0, max(metric.max_state_update_time_ns, metric.max_poll_time_ns) / self._wall_ns
        )
