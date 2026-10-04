"""The contract every insight rule meets."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import fields, is_dataclass
from typing import TYPE_CHECKING, ClassVar, Generic, TypeVar

from polars_telemetry.model.insights.finding import Impact, Kind, Measure, Text

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
        """A one-line fact and an imperative fix; the evidence speaks for itself."""

    def impact(self, node: PlanNode, evidence: E, view: PlanView) -> Impact:
        return Impact(view.cpu_share(node), view.blocked_share(node))

    def measures(self, evidence: E) -> tuple[Measure, ...]:
        if not is_dataclass(evidence) or isinstance(evidence, type):
            return ()
        return tuple(
            Measure(f.name, value, f.metadata["unit"])
            for f in fields(evidence)
            if "unit" in f.metadata and (value := getattr(evidence, f.name)) is not None
        )
