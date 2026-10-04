"""The same plugin call on the same input more than once within one node."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Text, unit
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


@dataclass(frozen=True, slots=True)
class Calls:
    calls: int = unit("count")
    repeated: int = unit("count")


class RepeatedPluginCall(Rule[Calls]):
    id: ClassVar[str] = "repeated_plugin_call"

    def check(self, node: PlanNode, view: PlanView) -> Calls | None:
        repeated = [c for c in node.traits.plugin_calls if c.count > 1]
        if not repeated:
            return None
        return Calls(max(c.count for c in repeated), len(repeated))

    def describe(self, evidence: Calls) -> Text:
        return Text(
            f"Identical plugin call runs {evidence.calls}x in one node",
            "compute it once with `with_columns` and reference that column",
        )
