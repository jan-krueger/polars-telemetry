"""A cross join pairing every row of two inputs that both have more than one."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Impact, Text, share, unit
from polars_telemetry.model.insights.rule import Rule
from polars_telemetry.model.types import NodeRole

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


@dataclass(frozen=True, slots=True)
class Pairs:
    rows_left: float = unit("rows")
    rows_right: float = unit("rows")
    rows_out: int = unit("rows")
    filter_keeps: float | None = unit("share")


class CrossJoin(Rule[Pairs]):
    id: ClassVar[str] = "cross_join"

    def check(self, node: PlanNode, view: PlanView) -> Pairs | None:
        if node.role is not NodeRole.CROSS_JOIN:
            return None
        sides = [view.rows_delivered(i) or 0 for i in view.inputs(node)]
        if len(sides) != 2 or min(sides) <= 1:
            return None
        out = view.rows_sent(node) or 0
        filters = [c for c in view.consumers(node) if c.role is NodeRole.SELECTION]
        kept = (view.rows_sent(filters[0]) or 0) / out if filters and out else None
        return Pairs(sides[0], sides[1], out, kept)

    def impact(self, node: PlanNode, evidence: Pairs, view: PlanView) -> Impact:
        region = (node, *view.carriers(node, max(evidence.rows_left, evidence.rows_right) * 2))
        return Impact(view.cpu_share(*region), view.blocked_share(node))

    def describe(self, evidence: Pairs) -> Text:
        if evidence.filter_keeps is not None:
            return Text(
                f"Cross join, then a filter keeps {share(evidence.filter_keeps)} of the pairs",
                "join on an equality key, or use `join_where`, instead of cross join + filter",
            )
        return Text(
            "Cross join of two multi-row inputs",
            "join on a key unless every pair is needed",
        )
