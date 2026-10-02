"""MessagePack payload decoding and contract checks.

Payload shapes (polars 1.44.x):
  IR plan, physical plan: [{id, input_ids, properties}]
  metrics snapshot:       [{phys_node_key, ...19 counters}]

Physical plan ids and phys_node_key share a namespace; metrics join on it.
"""

from __future__ import annotations

from typing import Any

import msgpack

PLAN_FIELDS: frozenset[str] = frozenset({"id", "input_ids", "properties"})

# Asserted against fixtures by tests/contract. A diff here means polars changed.
METRIC_FIELDS: frozenset[str] = frozenset(
    {
        "phys_node_key",
        "total_polls",
        "total_stolen_polls",
        "total_poll_time_ns",
        "max_poll_time_ns",
        "total_state_updates",
        "total_state_update_time_ns",
        "max_state_update_time_ns",
        "morsels_sent",
        "rows_sent",
        "largest_morsel_sent",
        "morsels_received",
        "rows_received",
        "largest_morsel_received",
        "io_total_active_ns",
        "io_total_bytes_requested",
        "io_total_bytes_received",
        "io_total_bytes_sent",
        "total_time_ns",
        "done",
    }
)

_COUNTER_FIELDS: frozenset[str] = METRIC_FIELDS - {"done"}


def _unpack(payload: bytes) -> list[dict[str, Any]]:
    decoded: Any = msgpack.unpackb(payload, raw=False, strict_map_key=False)
    if not isinstance(decoded, list):
        msg = f"expected a list payload, got {type(decoded).__name__}"
        raise ValueError(msg)
    return [dict(record) for record in decoded]


def decode_plan(payload: bytes) -> list[dict[str, Any]]:
    """Decode an IR or physical plan payload."""
    return _unpack(payload)


def decode_metrics(payload: bytes) -> list[dict[str, Any]]:
    """Decode a metrics snapshot payload."""
    return _unpack(payload)


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


def metrics_problems(records: list[dict[str, Any]]) -> list[str]:
    """Describe every way a metrics payload departs from the known contract."""
    problems: list[str] = []
    if not records:
        return ["metrics payload is empty"]

    for index, record in enumerate(records):
        missing = METRIC_FIELDS - record.keys()
        if missing:
            problems.append(f"record {index}: missing fields {sorted(missing)}")
        unexpected = record.keys() - METRIC_FIELDS
        if unexpected:
            problems.append(f"record {index}: unknown fields {sorted(unexpected)}")
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
