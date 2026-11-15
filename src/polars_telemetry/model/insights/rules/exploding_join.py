"""A join that emits more rows than both inputs together could without repeated keys."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Impact, Text, unit
from polars_telemetry.model.insights.rule import Rule
from polars_telemetry.model.types import NodeRole

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode

EXPLODES_AT = 2.0
"""A one-to-many join stays within its two inputs together, so at most twice the
larger one; beyond that, keys repeat on both sides. Spark and Databricks use 2x."""


@dataclass(frozen=True, slots=True)
class Explosion:
    rows_out: int = unit("rows")
    max_rows_in: float = unit("rows")
    growth: float = unit("ratio")
    theta: bool = False
    reorders_joins: bool = False


class ExplodingJoin(Rule[Explosion]):
    id: ClassVar[str] = "exploding_join"

    def check(self, node: PlanNode, view: PlanView) -> Explosion | None:
        if node.role not in (NodeRole.JOIN, NodeRole.THETA_JOIN):
            return None
        out, larger = view.rows_sent(node), view.larger_input_rows(node)
        if not out or not larger or out <= EXPLODES_AT * larger:
            return None
        return Explosion(
            out,
            larger,
            out / larger,
            node.role is NodeRole.THETA_JOIN,
            node.traits.reorders_joins and _joins(view) > 1,
        )

    def impact(self, node: PlanNode, evidence: Explosion, view: PlanView) -> Impact:
        region = (node, *view.carriers(node, evidence.max_rows_in * EXPLODES_AT))
        return Impact(view.cpu_share(*region), view.blocked_share(node))

    def describe(self, evidence: Explosion) -> Text:
        fix = (
            "if rows should only match within a key, add that equality to `join_where`"
            if evidence.theta
            else "if keys repeat by mistake: `unique(subset=keys)` one input first, "
            "or join on the full key"
        )
        if evidence.reorders_joins:
            fix += (
                "; if Polars reordered the joins, compare with "
                "`collect(optimizations=pl.QueryOptFlags(join_order=False))`"
            )
        return Text(f"Join emits {evidence.growth:.3g}x its larger input", fix)


def _joins(view: PlanView) -> int:
    return sum(n.role in (NodeRole.JOIN, NodeRole.THETA_JOIN) for n in view.query.plan.values())
