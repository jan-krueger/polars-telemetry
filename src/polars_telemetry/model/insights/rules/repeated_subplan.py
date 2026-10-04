"""The same subplan built and run more than once instead of shared."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Impact, Text, unit
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


@dataclass(frozen=True, slots=True)
class Repeats:
    copies: int = unit("count")
    nodes: int = unit("count")
    plugin_calls: int | None = unit("count")
    every_copy: tuple[int, ...] = ()


class RepeatedSubplan(Rule[Repeats]):
    id: ClassVar[str] = "repeated_subplan"

    def check(self, node: PlanNode, view: PlanView) -> Repeats | None:
        subplan = view.repeated_subplans.get(node.node_id)
        if subplan is None:
            return None
        first = subplan.copies[0]
        plugins = sum(call.count for i in first for call in view.query.plan[i].traits.plugin_calls)
        every = tuple(i for copy in subplan.copies for i in copy)
        return Repeats(len(subplan.roots), len(first), plugins or None, every)

    def impact(self, node: PlanNode, evidence: Repeats, view: PlanView) -> Impact:
        nodes = [view.query.plan[i] for i in evidence.every_copy]
        extra = (evidence.copies - 1) / evidence.copies
        return Impact(view.cpu_share(*nodes) * extra, 0.0)

    def describe(self, evidence: Repeats) -> Text:
        return Text(
            f"Same {evidence.nodes}-node subplan runs {evidence.copies}x",
            "`.cache()` the LazyFrame, or `collect()` it once",
        )
