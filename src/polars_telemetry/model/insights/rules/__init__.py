"""Every insight rule, in one explicit list."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from polars_telemetry.model.insights.rules.cross_join import CrossJoin
from polars_telemetry.model.insights.rules.exploding_join import ExplodingJoin
from polars_telemetry.model.insights.rules.in_memory_fallback import InMemoryFallback
from polars_telemetry.model.insights.rules.redundant_aggregation import RedundantAggregation
from polars_telemetry.model.insights.rules.repeated_string_scan import RepeatedStringScan

if TYPE_CHECKING:
    from polars_telemetry.model.insights.rule import Rule

RULES: tuple[Rule[Any], ...] = (
    InMemoryFallback(),
    ExplodingJoin(),
    CrossJoin(),
    RepeatedStringScan(),
    RedundantAggregation(),
)
