"""Masking literal values out of a query.

Applied to a whole `Query` before it reaches a receiver that asked for it, so
no exporter — including one an application wrote — has to remember to redact.
"""

from __future__ import annotations

import re
from dataclasses import replace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from polars_telemetry.model.types import PlanNode, Query

# Quoted text directly after these is a column or alias name, not user data.
_NAME_CONTEXT = re.compile(r"(?:col|alias|name|nth)\($")
_QUOTED = re.compile(r'"[^"]*"')
_NUMERIC = re.compile(r"(?<![\w.])\d+(?:\.\d+)?(?![\w.])")


def redact(expression: str) -> str:
    """Mask literal values in a plan expression, keeping its structure.

    Best effort over polars' textual expression form: quoted text is kept when
    it is a column or alias name and masked otherwise, and bare numbers are
    masked. Structure, column names and operators survive. Idempotent.
    """

    def mask_quoted(match: re.Match[str]) -> str:
        if _NAME_CONTEXT.search(expression[: match.start()]):
            return match.group(0)
        return '"<str>"'

    return _NUMERIC.sub("<num>", _QUOTED.sub(mask_quoted, expression))


def _walk(value: object) -> object:
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [_walk(item) for item in value]
    if isinstance(value, dict):
        return {key: _walk(item) for key, item in value.items()}
    return value


def _strings(values: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(redact(value) for value in values)


def _node(node: PlanNode) -> PlanNode:
    changes: dict[str, object] = {"properties": _walk(node.properties)}
    if node.scan is not None:
        changes["scan"] = replace(
            node.scan,
            source=redact(node.scan.source) if node.scan.source is not None else None,
            predicates=_strings(node.scan.predicates),
        )
    if node.join is not None:
        changes["join"] = replace(node.join, left_keys=_strings(node.join.left_keys))
    if node.sort is not None:
        changes["sort"] = replace(node.sort, columns=_strings(node.sort.columns))
    if node.aggregation is not None:
        changes["aggregation"] = replace(node.aggregation, keys=_strings(node.aggregation.keys))
    return replace(node, **changes)  # type: ignore[arg-type]


def redact_query(query: Query) -> Query:
    """The same query with every literal in its plans and failure text masked."""
    return replace(
        query,
        plan={node_id: _node(node) for node_id, node in query.plan.items()},
        logical={node_id: _node(node) for node_id, node in query.logical.items()},
        failed=redact(query.failed) if query.failed is not None else None,
    )
