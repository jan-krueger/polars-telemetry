"""Every insight rule, in one explicit list."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from polars_telemetry.model.insights.rules.cross_join import CrossJoin
from polars_telemetry.model.insights.rules.datetime_format_inferred import DatetimeFormatInferred
from polars_telemetry.model.insights.rules.exploding_join import ExplodingJoin
from polars_telemetry.model.insights.rules.in_memory_fallback import InMemoryFallback
from polars_telemetry.model.insights.rules.python_udf import PythonUdf
from polars_telemetry.model.insights.rules.redundant_aggregation import RedundantAggregation
from polars_telemetry.model.insights.rules.repeated_plugin_call import RepeatedPluginCall
from polars_telemetry.model.insights.rules.repeated_string_scan import RepeatedStringScan
from polars_telemetry.model.insights.rules.repeated_subplan import RepeatedSubplan

if TYPE_CHECKING:
    from polars_telemetry.model.insights.rule import Rule

RULES: tuple[Rule[Any], ...] = (
    InMemoryFallback(),
    ExplodingJoin(),
    CrossJoin(),
    RepeatedStringScan(),
    RedundantAggregation(),
    PythonUdf(),
    DatetimeFormatInferred(),
    RepeatedSubplan(),
    RepeatedPluginCall(),
)
