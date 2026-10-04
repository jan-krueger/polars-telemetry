"""An operation the streaming engine cannot run, handed to the in-memory engine."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Text
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


@dataclass(frozen=True, slots=True)
class Fallback:
    rows_in: float
    longest_step_ms: float


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
            "Runs on the in-memory engine",
            f"The streaming engine hands all {evidence.rows_in:,.0f} input rows to one call, "
            f"which took {evidence.longest_step_ms:,.0f} ms while the pipeline waited. "
            "A streaming equivalent, or fewer rows before this node, avoids it.",
        )
