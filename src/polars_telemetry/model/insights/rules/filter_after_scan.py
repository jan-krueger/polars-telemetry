"""A selective filter that Polars cannot push into the scan, for one of two known reasons."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar, Literal

from polars_telemetry.model.insights.finding import Impact, Text, share, unit
from polars_telemetry.model.insights.rule import Rule
from polars_telemetry.model.types import NodeRole

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode

KEEPS_AT = 0.1
"""A filter keeping at most this share of its rows leaves most of the scan's work unused."""

Cause = Literal["cast", "concat"]


@dataclass(frozen=True, slots=True)
class Blocked:
    rows_in: int = unit("rows")
    kept: float = unit("share")
    cause: Cause = "cast"
    upstream: tuple[int, ...] = ()


class FilterAfterScan(Rule[Blocked]):
    id: ClassVar[str] = "filter_after_scan"

    def check(self, node: PlanNode, view: PlanView) -> Blocked | None:
        metric = view.metrics(node)
        if node.role is not NodeRole.SELECTION or metric is None or not metric.rows_received:
            return None
        kept = metric.rows_sent / metric.rows_received
        if kept > KEEPS_AT:
            return None
        cause = _cause(node, view)
        if cause is None:
            return None
        return Blocked(metric.rows_received, kept, cause, _upstream(node, view))

    def impact(self, node: PlanNode, evidence: Blocked, view: PlanView) -> Impact:
        nodes = [view.query.plan[i] for i in evidence.upstream]
        return Impact(view.cpu_share(*nodes) * (1 - evidence.kept), 0.0)

    def describe(self, evidence: Blocked) -> Text:
        kept = share(evidence.kept)
        if evidence.cause == "cast":
            return Text(
                f"Filter keeps {kept} after a `cast` Polars cannot push it past",
                "filter before the `cast`, on the stored type, where the filter can be "
                "written for it and the cast cannot fail on the rows it drops",
            )
        return Text(
            f"Filter keeps {kept} after a horizontal concat Polars cannot push it past",
            "add the columns with `with_row_index` and a `join` on it instead of "
            '`concat(how="horizontal")`, so the filter reaches the scan',
        )


def _cause(node: PlanNode, view: PlanView) -> Cause | None:
    reads = set(node.traits.columns_read)
    current = _only_input(node, view)
    while current is not None:
        if reads & set(current.traits.columns_cast):
            return "cast" if _reaches_scan(current, view) else None
        if current.traits.aligns_by_position:
            return "concat" if _independent(current, view) else None
        if current.role is not NodeRole.PROJECTION:
            return None
        current = _only_input(current, view)
    return None


def _only_input(node: PlanNode, view: PlanView) -> PlanNode | None:
    inputs = view.inputs(node)
    return inputs[0] if len(inputs) == 1 else None


def _reaches_scan(node: PlanNode, view: PlanView) -> bool:
    current = _only_input(node, view)
    while current is not None and current.role is NodeRole.PROJECTION:
        current = _only_input(current, view)
    return current is not None and current.role is NodeRole.SCAN


def _independent(node: PlanNode, view: PlanView) -> bool:
    """Its inputs share no node below: separate frames, not columns of one."""
    below = [_ancestors(i, view) for i in view.inputs(node)]
    if len(below) < 2:
        return False
    seen: set[int] = set()
    for ids in below:
        if seen & ids:
            return False
        seen |= ids
    return any(view.query.plan[i].role is NodeRole.SCAN for i in seen)


def _ancestors(node: PlanNode, view: PlanView) -> set[int]:
    found, stack = {node.node_id}, [node]
    while stack:
        for parent in view.inputs(stack.pop()):
            if parent.node_id not in found:
                found.add(parent.node_id)
                stack.append(parent)
    return found


def _upstream(node: PlanNode, view: PlanView) -> tuple[int, ...]:
    return tuple(sorted(_ancestors(node, view) - {node.node_id}))
