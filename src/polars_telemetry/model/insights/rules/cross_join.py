"""A cross join pairing every row of two inputs that both have more than one."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Impact, Text, share
from polars_telemetry.model.insights.rule import Rule
from polars_telemetry.model.types import NodeRole

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


@dataclass(frozen=True, slots=True)
class Pairs:
    left: float
    right: float
    rows_out: int
    kept: float | None
    """Share of the pairs the next filter keeps, when a filter follows."""


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
        region = (node, *view.carriers(node, max(evidence.left, evidence.right) * 2))
        return Impact(view.cpu_share(*region), view.blocked_share(node))

    def describe(self, evidence: Pairs) -> Text:
        pairs = f"{evidence.left:,.0f} x {evidence.right:,.0f} = {evidence.rows_out:,} rows"
        if evidence.kept is not None:
            return Text(
                f"Cross join, then a filter keeps {share(evidence.kept)}",
                f"{pairs}, almost all discarded. An equality key, join_where or a pattern "
                "function such as str.contains_any avoids building the pairs.",
            )
        return Text(f"Cross join of {pairs}", f"{pairs}: check that every pair is wanted.")
