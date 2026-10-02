"""Span attributes derived from plan nodes."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from polars_telemetry.export import semconv

if TYPE_CHECKING:
    from polars_telemetry.model.types import PlanNode

AttributeValue = str | int | float | bool

# Quoted text directly after these is a column or alias name, not user data.
_NAME_CONTEXT = re.compile(r"(?:col|alias|name|nth)\($")
_QUOTED = re.compile(r'"[^"]*"')
_NUMERIC = re.compile(r"(?<![\w.])\d+(?:\.\d+)?(?![\w.])")


def redact(expression: str) -> str:
    """Mask literal values in a plan expression, keeping its structure.

    Best effort over polars' textual expression form: quoted text is kept when
    it is a column or alias name and masked otherwise, and bare numbers are
    masked. Structure, column names and operators survive.
    """

    def mask_quoted(match: re.Match[str]) -> str:
        if _NAME_CONTEXT.search(expression[: match.start()]):
            return match.group(0)
        return '"<str>"'

    return _NUMERIC.sub("<num>", _QUOTED.sub(mask_quoted, expression))


def _text(value: object, *, redact_literals: bool) -> str:
    rendered = value if isinstance(value, str) else str(value)
    return redact(rendered) if redact_literals else rendered


def node_attributes(node: PlanNode, *, redact_literals: bool = False) -> dict[str, AttributeValue]:
    """Plan detail worth attaching to a node span."""
    props = node.properties
    attrs: dict[str, AttributeValue] = {semconv.NODE_KIND: node.kind}

    source = props.get("first_source")
    if isinstance(source, str):
        attrs[semconv.SCAN_SOURCE] = _text(source, redact_literals=redact_literals)
    columns = props.get("projected_file_columns") or props.get("file_columns")
    if isinstance(columns, list):
        attrs[semconv.SCAN_COLUMNS] = len(columns)
    predicate = props.get("predicate")
    if predicate is not None:
        attrs[semconv.SCAN_PREDICATE] = _text(predicate, redact_literals=redact_literals)

    how = props.get("how")
    if isinstance(how, str):
        attrs[semconv.JOIN_HOW] = how
    left_on = props.get("left_on")
    if isinstance(left_on, list) and left_on:
        attrs[semconv.JOIN_LEFT_ON] = _text(
            ", ".join(str(item) for item in left_on), redact_literals=redact_literals
        )

    keys = props.get("key_per_input")
    if isinstance(keys, list) and keys:
        flattened = [str(key) for group in keys for key in group]
        attrs[semconv.GROUPBY_KEYS] = _text(", ".join(flattened), redact_literals=redact_literals)
    aggs = props.get("aggs_per_input")
    if isinstance(aggs, list):
        attrs[semconv.GROUPBY_AGGS] = sum(len(group) for group in aggs)

    return attrs
