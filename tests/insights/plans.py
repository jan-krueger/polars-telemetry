"""Small plans for insight tests, built through the adapter like a real query."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from polars_telemetry.adapter.build import build_metrics, build_plan
from polars_telemetry.model.types import Query


class Plan:
    def __init__(self) -> None:
        self._nodes: list[dict[str, Any]] = []
        self._metrics: list[dict[str, Any]] = []

    def node(
        self,
        node_id: int,
        kind: str,
        inputs: tuple[int, ...] = (),
        *,
        rows: int = 0,
        ms: float = 0.0,
        blocked_ms: float = 0.0,
        **properties: Any,
    ) -> Plan:
        self._nodes.append(
            {"id": node_id, "input_ids": list(inputs), "properties": {"type": kind, **properties}}
        )
        self._metrics.append(
            {
                "phys_node_key": node_id,
                "rows_sent": rows,
                "total_time_ns": int(ms * 1e6),
                "max_state_update_time_ns": int(blocked_ms * 1e6),
                "done": True,
            }
        )
        return self

    def query(self, wall_ms: float = 100.0) -> Query:
        return Query(
            query_id=uuid4(),
            wall_ms=wall_ms,
            plan=build_plan(self._nodes),
            metrics=build_metrics(self._metrics),
        )
