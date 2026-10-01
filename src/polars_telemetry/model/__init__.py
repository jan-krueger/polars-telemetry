"""Layer 2 -- version-independent model of a query.

Pure data and pure functions over decoded payloads. Nothing here imports
polars, which is what makes it testable from fixtures alone.
"""

from __future__ import annotations

__all__ = ["NodeMetrics", "PlanNode", "Query", "Sample"]

from polars_telemetry.model.types import NodeMetrics, PlanNode, Query, Sample
