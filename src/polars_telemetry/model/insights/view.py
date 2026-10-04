"""A query's plan, indexed once for every rule to ask questions of."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import cached_property
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.model.types import NodeMetrics, PlanNode, Query


@dataclass(frozen=True, slots=True)
class Subplan:
    """Identical work the plan runs more than once: each copy's root and own nodes."""

    roots: tuple[int, ...]
    copies: tuple[tuple[int, ...], ...]


SUBPLAN_NODES = 2


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

    @cached_property
    def _shapes(self) -> dict[int, str]:
        """A digest of each node's kind, properties and inputs: equal digests, equal work."""
        plan = self.query.plan
        shapes: dict[int, str] = {}
        stack = list(plan)
        while stack:
            node_id = stack[-1]
            if node_id in shapes:
                stack.pop()
                continue
            node = plan[node_id]
            pending = [i for i in node.inputs if i in plan and i not in shapes]
            if pending:
                stack.extend(pending)
                continue
            stack.pop()
            text = json.dumps([node.kind, node.properties], sort_keys=True, default=str)
            inputs = "|".join(shapes[i] for i in node.inputs if i in plan)
            shapes[node_id] = hashlib.blake2b(
                f"{text}|{inputs}".encode(), digest_size=16
            ).hexdigest()
        return shapes

    def _own(self, root: int) -> tuple[int, ...]:
        """The nodes only this root's subtree uses: below a shared node, work is done once."""
        own, stack = [], [root]
        while stack:
            node_id = stack.pop()
            if node_id in own or node_id not in self.query.plan:
                continue
            if node_id != root and len(self._consumers.get(node_id, ())) > 1:
                continue
            own.append(node_id)
            stack.extend(self.query.plan[node_id].inputs)
        return tuple(own)

    @cached_property
    def repeated_subplans(self) -> dict[int, Subplan]:
        """Subplans run more than once, by the first copy's root; nested repeats count once."""
        groups: dict[str, list[int]] = {}
        for node_id, shape in self._shapes.items():
            groups.setdefault(shape, []).append(node_id)
        repeated = {
            shape: sorted(ids)
            for shape, ids in groups.items()
            if len(ids) > 1 and len(self._own(min(ids))) >= SUBPLAN_NODES
        }

        def nested(node_id: int) -> bool:
            return any(self._shapes[c] in repeated for c in self._consumers.get(node_id, ()))

        return {
            ids[0]: Subplan(tuple(ids), tuple(self._own(i) for i in ids))
            for ids in repeated.values()
            if not all(nested(i) for i in ids)
        }

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
