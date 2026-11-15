"""The same sizeable expression computed in two nodes that see the same rows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Impact, Text, unit
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


@dataclass(frozen=True, slots=True)
class Twice:
    rows: int = unit("rows")
    other: int = 0


class RepeatedExpression(Rule[Twice]):
    id: ClassVar[str] = "repeated_expression"

    def check(self, node: PlanNode, view: PlanView) -> Twice | None:
        parts = set(node.traits.expression_parts)
        metric = view.metrics(node)
        if not parts or metric is None or not metric.rows_received:
            return None
        for fanout in _fanouts(node, view):
            for other in _below(fanout, view):
                if other.node_id == node.node_id or not parts & set(other.traits.expression_parts):
                    continue
                theirs = view.metrics(other)
                if theirs is None or theirs.rows_received != metric.rows_received:
                    continue
                if (view.cpu_share(other), other.node_id) < (view.cpu_share(node), node.node_id):
                    return Twice(metric.rows_received, other.node_id)
        return None

    def impact(self, node: PlanNode, evidence: Twice, view: PlanView) -> Impact:
        shares = [view.cpu_share(node), view.cpu_share(view.query.plan[evidence.other])]
        recorded = [share for share in shares if share > 0]
        return Impact(min(recorded) if recorded else 0.0, 0.0)

    def describe(self, evidence: Twice) -> Text:
        return Text(
            "Same expression computed in two nodes over the same rows",
            "compute it once, as a column with `with_columns` before both uses, "
            "and refer to that column",
        )


def _fanouts(node: PlanNode, view: PlanView) -> list[PlanNode]:
    """Nodes upstream that send their rows to several consumers."""
    found, seen, stack = [], {node.node_id}, [node]
    while stack:
        for parent in view.inputs(stack.pop()):
            if parent.node_id in seen:
                continue
            seen.add(parent.node_id)
            if len(view.consumers(parent)) > 1:
                found.append(parent)
            stack.append(parent)
    return found


def _below(fanout: PlanNode, view: PlanView) -> list[PlanNode]:
    """Every node downstream of the fan-out node."""
    found, seen, stack = [], {fanout.node_id}, [fanout]
    while stack:
        for child in view.consumers(stack.pop()):
            if child.node_id not in seen:
                seen.add(child.node_id)
                found.append(child)
                stack.append(child)
    return found
