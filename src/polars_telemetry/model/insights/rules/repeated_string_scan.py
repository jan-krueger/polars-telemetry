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
    "contains": "if they are OR'ed: one `str.contains_any` for literals, or one regex `a|b`",
}
_LITERAL = "if these are literal `replace_all`"
_ONE_PASS = frozenset({"replace", "contains"})


@dataclass(frozen=True, slots=True)
class Scans:
    function: str
    calls: int = unit("count")
    columns: int = unit("count")
    replace_many_calls: int | None = unit("count")


class RepeatedStringScan(Rule[Scans]):
    id: ClassVar[str] = "repeated_string_scan"

    def check(self, node: PlanNode, view: PlanView) -> Scans | None:
        repeated = [
            c
            for c in node.traits.string_calls
            if c.count >= REPEATED_AT and c.function in _ONE_PASS
        ]
        if not repeated:
            return None
        top = max(repeated, key=lambda c: c.count)
        same = sum(1 for c in repeated if c.function == top.function)
        runs = [r for r in node.traits.replace_runs if r.target == top.target]
        longest = max(runs, key=lambda r: r.calls, default=None)
        merged = longest.groups if top.function == "replace" and longest else None
        return Scans(top.function, top.count, same, merged)

    def describe(self, evidence: Scans) -> Text:
        where = "one column" if evidence.columns == 1 else f"each of {evidence.columns} columns"
        return Text(
            f"{evidence.calls}x `str.{evidence.function}` on {where}, one pass each",
            _fix(evidence),
        )


def _fix(evidence: Scans) -> str:
    if evidence.function != "replace":
        return _SINGLE_PASS[evidence.function]
    merged = evidence.replace_many_calls
    if merged is None:
        return "merge literal `replace_all` steps that cannot interact into `str.replace_many`"
    if merged == 1:
        return f"{_LITERAL}: merge into one `str.replace_many`"
    if merged < evidence.calls:
        return f"{_LITERAL}: merge into {merged} `str.replace_many` calls, in order"
    return "keep the chain: its steps interact, so `str.replace_many` would change the result"
