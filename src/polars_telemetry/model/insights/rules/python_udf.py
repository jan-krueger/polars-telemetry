"""A Python function the plan calls, which polars can neither optimise nor run in parallel."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Text, unit
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


@dataclass(frozen=True, slots=True)
class Udf:
    rows_in: float = unit("rows")
    longest_step: float = unit("ms")


class PythonUdf(Rule[Udf]):
    id: ClassVar[str] = "python_udf"

    def check(self, node: PlanNode, view: PlanView) -> Udf | None:
        if not node.traits.python_udf:
            return None
        metric = view.metrics(node)
        longest = (
            0 if metric is None else max(metric.max_state_update_time_ns, metric.max_poll_time_ns)
        )
        return Udf(view.larger_input_rows(node) or 0, longest / 1e6)

    def describe(self, evidence: Udf) -> Text:
        return Text(
            "Python UDF called from the plan",
            "replace `map_elements`/`map_batches` with native expressions or a plugin",
        )
