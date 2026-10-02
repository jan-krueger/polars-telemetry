"""Version-independent model. Does not import polars."""

from __future__ import annotations

__all__ = ["NodeMetrics", "PlanNode", "Query"]

from polars_telemetry.model.types import NodeMetrics, PlanNode, Query
