"""Insights: findings about a query's plan, from facts that do not depend on data size.

`evaluate` runs every registered rule over a query. Rules live one per module in
`rules/` and are listed in `rules.RULES`; adding one changes nothing else.
"""

from polars_telemetry.model.insights.engine import evaluate
from polars_telemetry.model.insights.finding import Finding, Kind, Level

__all__ = ["Finding", "Kind", "Level", "evaluate"]
