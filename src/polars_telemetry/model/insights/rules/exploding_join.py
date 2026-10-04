"""A join that emits more rows than both inputs together could without repeated keys."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Impact, Text
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
    rows_out: int
    larger_input: float
    growth: float


class ExplodingJoin(Rule[Explosion]):
    id: ClassVar[str] = "exploding_join"

    def check(self, node: PlanNode, view: PlanView) -> Explosion | None:
        if node.role not in (NodeRole.JOIN, NodeRole.THETA_JOIN):
            return None
        out, larger = view.rows_sent(node), view.larger_input_rows(node)
        if not out or not larger or out <= EXPLODES_AT * larger:
            return None
        return Explosion(out, larger, out / larger)

    def impact(self, node: PlanNode, evidence: Explosion, view: PlanView) -> Impact:
        region = (node, *view.carriers(node, evidence.larger_input * EXPLODES_AT))
        return Impact(view.cpu_share(*region), view.blocked_share(node))

    def describe(self, evidence: Explosion) -> Text:
        return Text(
            f"Join emits {evidence.growth:,.1f}x its larger input",
            f"{evidence.rows_out:,} rows out from at most {evidence.larger_input:,.0f} in: "
            "keys repeat on both sides. Deduplicate or aggregate one side first, or add the "
            "missing key column.",
        )
