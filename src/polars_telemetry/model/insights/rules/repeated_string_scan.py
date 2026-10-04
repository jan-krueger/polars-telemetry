"""The same string function applied to one column many times within a node."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Text
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode

REPEATED_AT = 4
"""TPC-H never calls one string function on one column more than once per node."""

_SINGLE_PASS = {
    "replace": "str.replace_many",
    "replace_all": "str.replace_many",
    "contains": "str.contains_any, or one regular expression",
}


@dataclass(frozen=True, slots=True)
class Scans:
    function: str
    calls: int
    columns: int
    """Columns in the node that see this many calls."""


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
        instead = _SINGLE_PASS.get(evidence.function, "combining them into one call")
        columns = "one column" if evidence.columns == 1 else f"each of {evidence.columns} columns"
        return Text(
            f"{evidence.calls} separate str.{evidence.function} calls on {columns}",
            f"Each call is another pass over the column. Consider {instead}; chained replacements "
            "can depend on their order, so check the result.",
        )
