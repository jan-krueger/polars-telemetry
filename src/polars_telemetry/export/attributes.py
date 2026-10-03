"""Span attributes derived from the plan."""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING

from polars_telemetry.export import semconv

if TYPE_CHECKING:
    from polars_telemetry.model.diagnostics import Diagnostics
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


def plan_json(query: Query, *, redact_literals: bool = False) -> str:
    """The whole plan and its counters, as one JSON document.

    Opt-in: it is kilobytes, and identical for every run of a shape. Carries
    the topology, which nothing else exports.
    """
    nodes = []
    for node_id, node in query.plan.items():
        metric = query.metrics.get(node_id)
        entry: dict[str, object] = {
            "id": node_id,
            "kind": node.kind,
            "inputs": list(node.inputs),
        }
        if metric is not None:
            entry.update(
                cpu_ms=round(metric.cpu_ms, 4),
                rows_in=metric.rows_received,
                rows_out=metric.rows_sent,
                morsels_in=metric.morsels_received,
                morsels_out=metric.morsels_sent,
                largest_morsel=metric.largest_morsel_received,
                polls=metric.total_polls,
                stolen=metric.total_stolen_polls,
                poll_ms=round(metric.total_poll_time_ns / 1e6, 4),
                max_poll_ms=round(metric.max_poll_time_ns / 1e6, 4),
                state_updates=metric.total_state_updates,
                state_update_ms=round(metric.total_state_update_time_ns / 1e6, 4),
                max_state_update_ms=round(metric.max_state_update_time_ns / 1e6, 4),
                io_ms=round(metric.io_total_active_ns / 1e6, 4),
                io_bytes_received=metric.io_total_bytes_received,
                io_bytes_requested=metric.io_total_bytes_requested,
                io_bytes_sent=metric.io_total_bytes_sent,
                done=metric.done,
            )
        nodes.append(entry)
    logical = [
        {"id": nid, "kind": n.kind, "inputs": list(n.inputs)} for nid, n in query.logical.items()
    ]
    return json.dumps({"physical": nodes, "logical": logical}, separators=(",", ":"))


def _add_diagnostics(attrs: dict[str, AttributeValue], diagnostics: Diagnostics) -> None:
    for key, value in (
        (semconv.PARALLEL_EFFICIENCY, diagnostics.parallel_efficiency),
        (semconv.CPU_COUNT, diagnostics.cpu_count),
        (semconv.FILTER_SELECTIVITY, diagnostics.filter_selectivity),
        (semconv.FILTER_ROWS_DROPPED, diagnostics.filter_rows_dropped),
        (semconv.JOIN_AMPLIFICATION, diagnostics.join_amplification),
        (semconv.PROJECTION_EFFICIENCY, diagnostics.projection_efficiency),
        (semconv.MORSEL_SKEW, diagnostics.morsel_skew),
        (semconv.SCAN_PREDICATE_PUSHED, diagnostics.predicate_pushed),
        (semconv.SCAN_ROW_GROUPS_SKIPPED, diagnostics.row_groups_skipped),
        (semconv.SCAN_HAS_STATISTICS, diagnostics.has_table_statistics),
    ):
        if value is None:
            continue
        attrs[key] = round(value, 4) if isinstance(value, float) else value
    attrs[semconv.METRICS_COMPLETE] = diagnostics.complete
    if diagnostics.incomplete_nodes:
        attrs[semconv.METRICS_INCOMPLETE_NODES] = diagnostics.incomplete_nodes


def query_attributes(
    query: Query,
    *,
    redact_literals: bool = False,
    diagnostics: Diagnostics | None = None,
    plan_fingerprint: str | None = None,
    include_plan: bool = False,
) -> dict[str, AttributeValue]:
    """Everything worth knowing about the query, on one span.

    Per-node detail is aggregated here rather than split across child spans,
    because polars gives no per-node timing to place those spans on.
    """
    attrs: dict[str, AttributeValue] = {
        semconv.QUERY_ID: str(query.query_id),
        semconv.ENGINE: "streaming",
        semconv.NODE_COUNT: len(query.plan),
    }
    if query.call_site is not None:
        attrs[semconv.CODE_FILE_PATH] = query.call_site.filepath
        attrs[semconv.CODE_LINE_NUMBER] = query.call_site.lineno
        attrs[semconv.CODE_FUNCTION_NAME] = query.call_site.function
    if query.metrics:
        attrs[semconv.CPU_MS] = round(query.cpu_ms, 3)
        attrs[semconv.PARALLELISM] = round(query.parallelism, 3)
    if query.result_rows is not None:
        attrs[semconv.RESULT_ROWS] = query.result_rows

    if plan_fingerprint is not None:
        attrs[semconv.PLAN_FINGERPRINT] = plan_fingerprint
    if diagnostics is not None:
        _add_diagnostics(attrs, diagnostics)
    if include_plan:
        attrs[semconv.PLAN] = plan_json(query, redact_literals=redact_literals)

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

    sort_columns: list[str] = []
    sources: list[str] = []
    predicates: list[str] = []
    columns = 0
    join_types: list[str] = []
    join_keys: list[str] = []
    groupby_keys: list[str] = []
    scans = joins = groupbys = 0

    # Columns actually read are only on the physical plan: the IR carries
    # file_columns, which is the width of the file, not of the projection.
    for node in query.plan.values():
        if node.kind in _SCAN_KINDS:
            read = node.properties.get("projected_file_columns")
            if isinstance(read, list):
                columns += len(read)

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

        elif node.kind in _JOIN_KINDS:
            joins += 1
            how = props.get("how")
            if isinstance(how, str):
                join_types.append(how)
            left_on = props.get("left_on")
            if isinstance(left_on, list):
                join_keys.extend(_text(key, redact_literals=redact_literals) for key in left_on)
        elif node.kind == "Sort":
            specs = props.get("sort_columns")
            if isinstance(specs, list):
                for spec in specs:
                    if isinstance(spec, dict) and "expr" in spec:
                        sort_columns.append(_text(spec["expr"], redact_literals=redact_literals))
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
    if sort_columns:
        attrs[semconv.SORT_COLUMNS] = tuple(sort_columns)

    return attrs
