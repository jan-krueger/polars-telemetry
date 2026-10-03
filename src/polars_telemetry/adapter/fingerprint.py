"""Stable identity for a query *shape*.

In the adapter because it hashes polars' own kind names and property values:
it is a function of polars' vocabulary, computed once as a query arrives.

A query id identifies one run and is unbounded, so it can never be a metric
dimension. The plan shape is bounded by the application's code paths, so it
can: the same query with different parameter values hashes the same.

Derived from the IR, which keeps the user's own column names; the physical
plan renames them per run. Literals are masked before hashing, and a scanned
file counts by its name, with numbers and dates masked, so neither parameter
values nor dated file names start new metric series.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import TYPE_CHECKING

from polars_telemetry.model.redaction import plugin_libraries, redact

if TYPE_CHECKING:
    from polars_telemetry.model.types import PlanNode

_STRUCTURAL = (
    "first_source",
    "scan_type",
    "file_columns",
    "projection",
    "projected_file_columns",
    "columns",
    "how",
    "left_on",
    "right_on",
    "keys",
    "aggs",
    "sort_columns",
    "maintain_order",
)

FINGERPRINT_LENGTH = 12


def _shape(key: str, value: object) -> object:
    if isinstance(value, str):
        if key == "first_source":
            value = re.split(r"[/\\]", value)[-1]
        return redact(plugin_libraries(value))
    if isinstance(value, list):
        return [_shape(key, item) for item in value]
    if isinstance(value, dict):
        return {k: _shape(key, v) for k, v in value.items()}
    return value


def fingerprint(plan: dict[int, PlanNode]) -> str:
    """Hash the plan's structure. Stable across runs, distinct across shapes."""
    parts: list[str] = []
    for node_id in sorted(plan):
        node = plan[node_id]
        signature: list[object] = [node.kind, tuple(sorted(node.inputs))]
        for key in _STRUCTURAL:
            value = node.properties.get(key)
            if value is not None:
                signature.append((key, json.dumps(_shape(key, value), default=str, sort_keys=True)))
        parts.append(repr(signature))
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()
    return digest[:FINGERPRINT_LENGTH]
