"""Stable identity for a query *shape*.

A query id identifies one run and is unbounded, so it can never be a metric
dimension. The plan shape is bounded by the application's code paths, so it
can: the same query with different parameter values hashes the same.

Derived from the IR, which keeps the user's own column names; the physical
plan renames them per run.
"""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.model.types import PlanNode

# Properties that describe structure. Literal values are deliberately absent:
# `amount > 10` and `amount > 90` are the same shape.
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


def fingerprint(plan: dict[int, PlanNode]) -> str:
    """Hash the plan's structure. Stable across runs, distinct across shapes."""
    parts: list[str] = []
    for node_id in sorted(plan):
        node = plan[node_id]
        signature: list[object] = [node.kind, tuple(sorted(node.inputs))]
        for key in _STRUCTURAL:
            value = node.properties.get(key)
            if value is not None:
                signature.append((key, json.dumps(value, default=str, sort_keys=True)))
        parts.append(repr(signature))
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()
    return digest[:FINGERPRINT_LENGTH]
