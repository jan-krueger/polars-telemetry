"""Span attributes derived from the plan."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from polars_telemetry.export import semconv

if TYPE_CHECKING:
    from polars_telemetry.model.types import Query

AttributeValue = str | int | float | bool | tuple[str, ...]

# Quoted text directly after these is a column or alias name, not user data.
_NAME_CONTEXT = re.compile(r"(?:col|alias|name|nth)\($")
_QUOTED = re.compile(r'"[^"]*"')
_NUMERIC = re.compile(r"(?<![\w.])\d+(?:\.\d+)?(?![\w.])")

_JOIN_KINDS = frozenset({"EquiJoin", "CrossJoin", "SemiAntiJoin", "IEJoin", "Join"})
_SCAN_KINDS = frozenset({"MultiScan", "Scan"})


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


def query_attributes(query: Query, *, redact_literals: bool = False) -> dict[str, AttributeValue]:
    """Everything worth knowing about the query, on one span.

    Per-node detail is aggregated here rather than split across child spans,
    because polars gives no per-node timing to place those spans on.
    """
    attrs: dict[str, AttributeValue] = {
        semconv.QUERY_ID: str(query.query_id),
        semconv.ENGINE: "streaming",
        semconv.NODE_COUNT: len(query.plan),
    }
    if query.metrics:
        attrs[semconv.CPU_MS] = round(query.cpu_ms, 3)
        attrs[semconv.PARALLELISM] = round(query.parallelism, 3)
    if query.result_rows is not None:
        attrs[semconv.RESULT_ROWS] = query.result_rows

    hottest = query.hottest
    if hottest is not None and query.cpu_ms > 0:
        node, metric = hottest
        attrs[semconv.HOT_NODE_KIND] = node.kind
        attrs[semconv.HOT_NODE_CPU_MS] = round(metric.cpu_ms, 3)
        attrs[semconv.HOT_NODE_SHARE] = round(metric.cpu_ms / query.cpu_ms, 4)

    # The IR plan keeps the user's own column names; the physical plan rewrites
    # group-by keys and aggregations to _POLARS_TMP_N. Prefer the IR for
    # anything a person reads, and fall back when it is unavailable.
    semantic = query.logical or query.plan

    sources: list[str] = []
    predicates: list[str] = []
    columns = 0
    join_types: list[str] = []
    join_keys: list[str] = []
    groupby_keys: list[str] = []
    scans = joins = groupbys = 0

    for node in semantic.values():
        props = node.properties
        if node.kind in _SCAN_KINDS:
            scans += 1
            source = props.get("first_source")
            if isinstance(source, str):
                sources.append(_text(source, redact_literals=redact_literals))
            predicate = props.get("predicate")
            # The IR reports a list of predicates; the physical plan one string.
            if isinstance(predicate, list):
                predicates.extend(
                    _text(item, redact_literals=redact_literals) for item in predicate
                )
            elif predicate is not None:
                predicates.append(_text(predicate, redact_literals=redact_literals))
            projected = props.get("projected_file_columns") or props.get("file_columns")
            if isinstance(projected, list):
                columns += len(projected)
        elif node.kind in _JOIN_KINDS:
            joins += 1
            how = props.get("how")
            if isinstance(how, str):
                join_types.append(how)
            left_on = props.get("left_on")
            if isinstance(left_on, list):
                join_keys.extend(_text(key, redact_literals=redact_literals) for key in left_on)
        elif node.kind == "GroupBy":
            groupbys += 1
            # The IR exposes a flat `keys`; the physical plan nests them under
            # `key_per_input` and renames them to _POLARS_TMP_N.
            keys = props.get("keys")
            if isinstance(keys, list):
                groupby_keys.extend(_text(key, redact_literals=redact_literals) for key in keys)
            elif isinstance(nested := props.get("key_per_input"), list):
                groupby_keys.extend(
                    _text(key, redact_literals=redact_literals) for group in nested for key in group
                )

    if scans:
        attrs[semconv.SCAN_COUNT] = scans
        attrs[semconv.SCAN_COLUMNS] = columns
    if sources:
        attrs[semconv.SCAN_SOURCES] = tuple(sources)
    if predicates:
        attrs[semconv.SCAN_PREDICATES] = tuple(predicates)
    if joins:
        attrs[semconv.JOIN_COUNT] = joins
    if join_types:
        attrs[semconv.JOIN_TYPES] = tuple(join_types)
    if join_keys:
        attrs[semconv.JOIN_KEYS] = tuple(join_keys)
    if groupbys:
        attrs[semconv.GROUPBY_COUNT] = groupbys
    if groupby_keys:
        attrs[semconv.GROUPBY_KEYS] = tuple(groupby_keys)

    return attrs
