"""The contract every insight rule meets."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, is_dataclass
from typing import TYPE_CHECKING, ClassVar, Generic, TypeVar

from polars_telemetry.model.insights.finding import Impact, Kind, Text

if TYPE_CHECKING:
    from polars_telemetry.model.insights.view import PlanView
    from polars_telemetry.model.types import PlanNode

E = TypeVar("E")


class Rule(ABC, Generic[E]):
    """Detects one pattern from facts alone; the engine decides how much it matters."""

    id: ClassVar[str]
    """Public and stable: exported with every finding."""
    kind: ClassVar[Kind] = "problem"

    @abstractmethod
    def check(self, node: PlanNode, view: PlanView) -> E | None:
        """Evidence that `node` shows the pattern, or None."""

    @abstractmethod
    def describe(self, evidence: E) -> Text:
        """Title and detail from the evidence: numbers and node kinds only."""

    def impact(self, node: PlanNode, evidence: E, view: PlanView) -> Impact:
        return Impact(view.cpu_share(node), view.blocked_share(node))

    def numbers(self, evidence: E) -> dict[str, int | float | bool]:
        values = (
            asdict(evidence) if is_dataclass(evidence) and not isinstance(evidence, type) else {}
        )
        return {k: v for k, v in values.items() if isinstance(v, int | float | bool)}
