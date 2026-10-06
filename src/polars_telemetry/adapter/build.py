"""Construct model objects from decoded payloads.

Translation, so it lives in the adapter: it knows the payload field names and
assigns each node its role through the dialect.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from polars_telemetry.adapter.dialect import described, facets, role_of
from polars_telemetry.adapter.fingerprint import fingerprint
from polars_telemetry.adapter.traits import with_traits
from polars_telemetry.model.diagnostics import derive
from polars_telemetry.model.insights import evaluate
from polars_telemetry.model.types import COUNTER_NAMES, CustomMetric, NodeMetrics, PlanNode, Query


def build_plan(records: list[dict[str, Any]]) -> dict[int, PlanNode]:
    """Index plan nodes by id."""
    nodes: dict[int, PlanNode] = {}
    for record in records:
        properties = described(dict(record["properties"]))
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
            custom=_custom(record.get("custom")),
        )
    return metrics


def _custom(entries: object) -> tuple[CustomMetric, ...]:
    if not isinstance(entries, list):
        return ()
    return tuple(
        CustomMetric(
            str(entry["key"]),
            str(entry.get("unit", "1")),
            value
            if isinstance(value := entry.get("value"), int) and not isinstance(value, bool)
            else None,
        )
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("key"), str)
    )


def threads() -> int:
    """Threads polars can run a query on: its pool, which honours CPU affinity,
    a cgroup CPU quota and POLARS_MAX_THREADS, unlike os.cpu_count()."""
    import polars

    return polars.thread_pool_size()


def enrich(query: Query, *, insights: bool = False) -> Query:
    """Attach what every consumer would otherwise derive for itself.

    Before any redaction, so the fingerprint is the same whatever a receiver's
    privacy settings are. With `insights`, the plan gains its traits and the
    query its findings.
    """
    enriched = replace(
        query,
        fingerprint=fingerprint(query.logical or query.plan),
        diagnostics=derive(query, threads()),
    )
    if not insights:
        return enriched
    version = query.polars_version
    traced = replace(
        enriched,
        plan=with_traits(query.plan, version),
        logical=with_traits(query.logical, version),
    )
    return replace(traced, insights=evaluate(traced))
