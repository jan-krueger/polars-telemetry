"""An operation the streaming engine cannot run, handed to the in-memory engine."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Text, unit
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


@dataclass(frozen=True, slots=True)
class Fallback:
    rows_in: float = unit("rows")
    longest_step: float = unit("ms")


class InMemoryFallback(Rule[Fallback]):
    id: ClassVar[str] = "in_memory_fallback"

    def check(self, node: PlanNode, view: PlanView) -> Fallback | None:
        if not node.traits.in_memory_fallback or node.traits.python_udf:
            return None
        metric = view.metrics(node)
        longest = (
            0 if metric is None else max(metric.max_state_update_time_ns, metric.max_poll_time_ns)
        )
        return Fallback(view.larger_input_rows(node) or 0, longest / 1e6)

    def describe(self, evidence: Fallback) -> Text:
        return Text(
            "In-memory fallback: all input rows in one call",
            "use a streaming-native expression, or reduce rows before this node",
        )
