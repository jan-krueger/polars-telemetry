"""The same string function applied to one column many times within a node."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Text, unit
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode

REPEATED_AT = 4
"""TPC-H never calls one string function on one column more than once per node."""

_SINGLE_PASS = {
    "replace": "merge into one `str.replace_many`; chained replacements can depend on order",
    "replace_all": "merge into one `str.replace_many`; chained replacements can depend on order",
    "contains": "merge into one `str.contains_any`, or one regex",
}


@dataclass(frozen=True, slots=True)
class Scans:
    function: str
    calls: int = unit("count")
    columns: int = unit("count")


class RepeatedStringScan(Rule[Scans]):
    id: ClassVar[str] = "repeated_string_scan"

    def check(self, node: PlanNode, view: PlanView) -> Scans | None:
        repeated = [c for c in node.traits.string_calls if c.count >= REPEATED_AT]
        if not repeated:
            return None
        top = max(repeated, key=lambda c: c.count)
        same = sum(1 for c in repeated if c.function == top.function)
        return Scans(top.function, top.count, same)

    def describe(self, evidence: Scans) -> Text:
        where = "one column" if evidence.columns == 1 else f"each of {evidence.columns} columns"
        return Text(
            f"{evidence.calls}x `str.{evidence.function}` on {where}, one pass each",
            _SINGLE_PASS.get(evidence.function, "merge them into one call"),
        )
