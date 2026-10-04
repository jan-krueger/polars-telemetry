"""A string parsed to a date or time without a format, so polars infers one from the data."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from polars_telemetry.model.insights.finding import Text, unit
from polars_telemetry.model.insights.rule import Rule

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode


@dataclass(frozen=True, slots=True)
class Inferred:
    rows_in: float = unit("rows")


class DatetimeFormatInferred(Rule[Inferred]):
    id: ClassVar[str] = "datetime_format_inferred"

    def check(self, node: PlanNode, view: PlanView) -> Inferred | None:
        if not node.traits.infers_datetime_format:
            return None
        return Inferred(view.larger_input_rows(node) or 0)

    def describe(self, evidence: Inferred) -> Text:
        return Text(
            "Datetime format inferred from the data",
            "pass `format=` to `str.to_datetime`/`str.strptime`",
        )
