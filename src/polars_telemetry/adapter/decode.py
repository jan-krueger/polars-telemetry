"""MessagePack payload decoding and contract checks.

Payload shapes (polars 1.44.x and 2.x, which agree):
  IR plan, physical plan: [{id, input_ids, properties}]
  metrics snapshot:       [{phys_node_key, ...19 counters}], or
                          {query: {...}, nodes: [{phys_node_key, ...}]} once polars
                          adds query-level metrics (pola-rs/polars#29792)

Physical plan ids and phys_node_key share a namespace; metrics join on it.
"""

from __future__ import annotations

from typing import Any

import msgpack

from polars_telemetry.model.types import COUNTER_NAMES

PLAN_FIELDS: frozenset[str] = frozenset({"id", "input_ids", "properties"})

# Asserted against fixtures by tests/contract. A diff here means polars changed.
# polars' counter names are the model's field names; should they ever diverge,
# the translation belongs in the dialect, not here.
METRIC_FIELDS: frozenset[str] = frozenset({*COUNTER_NAMES, "phys_node_key", "done"})
OPTIONAL_METRIC_FIELDS: frozenset[str] = frozenset({"custom"})
"""Sent only by newer polars: `custom` since 2.0."""

_COUNTER_FIELDS: frozenset[str] = METRIC_FIELDS - {"done"}


def _coerce(decoded: Any) -> list[dict[str, Any]]:
    if not isinstance(decoded, list):
        msg = f"expected a list payload, got {type(decoded).__name__}"
        raise ValueError(msg)
    return [dict(record) for record in decoded]


def _unpack(payload: bytes) -> list[dict[str, Any]]:
    return _coerce(msgpack.unpackb(payload, raw=False, strict_map_key=False))


def decode_plan(payload: bytes) -> list[dict[str, Any]]:
    """Decode an IR or physical plan payload."""
    return _unpack(payload)


_NIL: bytes = msgpack.packb(None)


def is_nil(payload: bytes) -> bool:
    """Whether polars sent no plan at all, as opposed to one we cannot read."""
    return payload == _NIL


def decode_optional_plan(payload: bytes) -> list[dict[str, Any]] | None:
    """Decode a plan payload, or return None when polars sent nil.

    Eager DataFrame operations do not run on the streaming engine, so there is
    no physical plan; polars passes msgpack nil rather than omitting it.
    """
    decoded: Any = msgpack.unpackb(payload, raw=False, strict_map_key=False)
    return None if decoded is None else _coerce(decoded)


def decode_metrics(payload: bytes) -> list[dict[str, Any]]:
    """Decode a metrics snapshot payload into its node rows."""
    return decode_snapshot(payload)[0]


def _query_metrics(query: Any) -> dict[str, int] | None:
    if not isinstance(query, dict):
        return None
    return {
        str(key): value
        for key, value in query.items()
        if isinstance(value, int) and not isinstance(value, bool)
    }


def decode_snapshot(payload: bytes) -> tuple[list[dict[str, Any]], dict[str, int] | None]:
    """Decode a metrics snapshot into node rows and query-level metrics, if sent."""
    decoded = msgpack.unpackb(payload, raw=False, strict_map_key=False)
    if isinstance(decoded, dict) and "nodes" in decoded:
        query = decoded.get("query")
        return _coerce(decoded["nodes"]), _query_metrics(query)
    return _coerce(decoded), None


def plan_problems(records: list[dict[str, Any]]) -> list[str]:
    """Describe every way a plan payload departs from the known contract.

    Returns an empty list when the payload matches. Used by the capability
    probe and by both halves of the contract tests.
    """
    problems: list[str] = []
    if not records:
        return ["plan payload is empty"]

    ids = {record.get("id") for record in records}
    for index, record in enumerate(records):
        missing = PLAN_FIELDS - record.keys()
        if missing:
            problems.append(f"node {index}: missing fields {sorted(missing)}")
            continue
        if not isinstance(record["id"], int):
            problems.append(f"node {index}: id is {type(record['id']).__name__}, expected int")
        if not isinstance(record["input_ids"], list):
            problems.append(f"node {index}: input_ids is not a list")
        else:
            unknown = [i for i in record["input_ids"] if i not in ids]
            if unknown:
                problems.append(f"node {record['id']}: input_ids reference unknown nodes {unknown}")
        properties = record["properties"]
        if not isinstance(properties, dict):
            problems.append(f"node {index}: properties is not a map")
        elif "type" not in properties:
            problems.append(f"node {record['id']}: properties has no 'type'")
    return problems


def metrics_additions(records: list[dict[str, Any]]) -> list[str]:
    """Counters polars reports that we do not model yet.

    Worth reporting, never fatal: a field we ignore costs nothing, and treating
    it as a break would disable node metrics the day polars adds a counter.
    """
    additions: list[str] = []
    for index, record in enumerate(records):
        unexpected = record.keys() - METRIC_FIELDS - OPTIONAL_METRIC_FIELDS
        if unexpected:
            additions.append(f"record {index}: unknown fields {sorted(unexpected)}")
        custom = record.get("custom", [])
        if not isinstance(custom, list) or not all(_custom_metric(c) for c in custom):
            additions.append(f"record {index}: custom metrics in an unknown shape, left out")
    return additions


def metrics_breaks(records: list[dict[str, Any]]) -> list[str]:
    """Departures that make the counters unusable: missing or retyped fields."""
    problems: list[str] = []
    if not records:
        return ["metrics payload is empty"]

    for index, record in enumerate(records):
        missing = METRIC_FIELDS - record.keys()
        if missing:
            problems.append(f"record {index}: missing fields {sorted(missing)}")
        for field_name in _COUNTER_FIELDS & record.keys():
            value = record[field_name]
            if not isinstance(value, int) or isinstance(value, bool):
                problems.append(
                    f"record {index}: {field_name} is {type(value).__name__}, expected int"
                )
        if "done" in record and not isinstance(record["done"], bool):
            problems.append(
                f"record {index}: done is {type(record['done']).__name__}, expected bool"
            )
    return problems


def _custom_metric(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    value = entry.get("value")
    return (
        isinstance(entry.get("key"), str)
        and isinstance(entry.get("unit"), str)
        and (value is None or (isinstance(value, int) and not isinstance(value, bool)))
    )


def metrics_problems(records: list[dict[str, Any]]) -> list[str]:
    """Every way a metrics payload departs from the known contract."""
    return metrics_breaks(records) + metrics_additions(records)
