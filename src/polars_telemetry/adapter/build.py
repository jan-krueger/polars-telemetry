"""Construct model objects from decoded payloads.

Translation, so it lives in the adapter: it knows the payload field names and
assigns each node its role through the dialect.
"""

from __future__ import annotations

from typing import Any

from polars_telemetry.adapter.dialect import facets, role_of
from polars_telemetry.model.types import COUNTER_NAMES, NodeMetrics, PlanNode


def build_plan(records: list[dict[str, Any]]) -> dict[int, PlanNode]:
    """Index plan nodes by id."""
    nodes: dict[int, PlanNode] = {}
    for record in records:
        properties = dict(record["properties"])
        kind = str(properties.get("type", "Unknown"))
        role = role_of(kind, properties)
        nodes[int(record["id"])] = PlanNode(
            node_id=int(record["id"]),
            kind=kind,
            inputs=tuple(int(i) for i in record["input_ids"]),
            properties=properties,
            role=role,
            **facets(role, properties),
        )
    return nodes


def build_metrics(records: list[dict[str, Any]]) -> dict[int, NodeMetrics]:
    """Index node metrics by physical node id."""
    metrics: dict[int, NodeMetrics] = {}
    for record in records:
        node_id = int(record["phys_node_key"])
        metrics[node_id] = NodeMetrics(
            node_id=node_id,
            done=bool(record.get("done", False)),
            **{name: int(record.get(name, 0)) for name in COUNTER_NAMES},
        )
    return metrics
