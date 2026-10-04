"""A grouping or deduplication that returns (nearly) every row it received."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Text
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


REMOVES_AT_MOST = 1e-4
"""Removing at most one row in ten thousand is too little to need the step itself."""


@dataclass(frozen=True, slots=True)
class Unchanged:
    rows_in: float
    removed: float


class RedundantAggregation(Rule[Unchanged]):
    id: ClassVar[str] = "redundant_aggregation"

    def check(self, node: PlanNode, view: PlanView) -> Unchanged | None:
        if not node.traits.deduplicates or not view.asks_for_deduplication:
            return None
        out, received = view.rows_sent(node), view.larger_input_rows(node)
        if not out or not received or out <= 1 or out < received * (1 - REMOVES_AT_MOST):
            return None
        return Unchanged(received, max(0.0, received - out))

    def describe(self, evidence: Unchanged) -> Text:
        if not evidence.removed:
            return Text(
                "Grouping kept every row",
                f"{evidence.rows_in:,.0f} rows in and out: every key is already unique here. "
                "If that holds by construction, this step can go.",
            )
        return Text(
            f"Grouping removed only {evidence.removed:,.0f} of {evidence.rows_in:,.0f} rows",
            "Almost every key is already unique. Avoiding the few duplicates earlier would let "
            "this step go.",
        )
