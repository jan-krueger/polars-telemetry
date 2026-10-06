"""Span attributes derived from the plan."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from polars_telemetry.export import semconv

if TYPE_CHECKING:
    from polars_telemetry.model.diagnostics import Diagnostics
    from polars_telemetry.model.types import Query

AttributeValue = str | int | float | bool | tuple[str, ...]


def _text(value: object) -> str:
    return value if isinstance(value, str) else str(value)


# The include_plan JSON names counters for readers rather than for polars, and
# gives time in milliseconds. Every counter must appear; a test holds that.
PLAN_JSON_FIELDS: tuple[tuple[str, str], ...] = (
    ("cpu_ms", "total_time_ns"),
    ("rows_in", "rows_received"),
    ("rows_out", "rows_sent"),
    ("morsels_in", "morsels_received"),
    ("morsels_out", "morsels_sent"),
    ("largest_morsel", "largest_morsel_received"),
    ("largest_morsel_out", "largest_morsel_sent"),
    ("polls", "total_polls"),
    ("stolen", "total_stolen_polls"),
    ("poll_ms", "total_poll_time_ns"),
    ("max_poll_ms", "max_poll_time_ns"),
    ("state_updates", "total_state_updates"),
    ("state_update_ms", "total_state_update_time_ns"),
    ("max_state_update_ms", "max_state_update_time_ns"),
    ("io_ms", "io_total_active_ns"),
    ("io_bytes_received", "io_total_bytes_received"),
    ("io_bytes_requested", "io_total_bytes_requested"),
    ("io_bytes_sent", "io_total_bytes_sent"),
)


def plan_json(query: Query) -> str:
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
            for name, counter in PLAN_JSON_FIELDS:
                value = getattr(metric, counter)
                entry[name] = round(value / 1e6, 4) if counter.endswith("_ns") else value
            entry["done"] = metric.done
            if metric.custom:
                entry["custom"] = {c.key: c.value for c in metric.custom}
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
        (semconv.JOIN_GROWTH, diagnostics.join_growth),
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
        semconv.NODE_COUNT: len(query.plan),
    }
    if query.engine is not None:
        attrs[semconv.ENGINE] = query.engine
    if query.label is not None:
        attrs[semconv.QUERY_LABEL] = query.label
    if query.call_site is not None:
        attrs[semconv.CODE_FILE_PATH] = query.call_site.filepath
        attrs[semconv.CODE_LINE_NUMBER] = query.call_site.lineno
        attrs[semconv.CODE_FUNCTION_NAME] = query.call_site.function
    if query.planning_ms is not None:
        attrs[semconv.PLANNING_MS] = round(query.planning_ms, 3)
    if query.telemetry_ms is not None:
        attrs[semconv.TELEMETRY_MS] = round(query.telemetry_ms, 3)
    if query.metrics:
        attrs[semconv.CPU_MS] = round(query.cpu_ms, 3)
        attrs[semconv.PARALLELISM] = round(query.parallelism, 3)
    if query.result_rows is not None:
        attrs[semconv.RESULT_ROWS] = query.result_rows

    if plan_fingerprint is not None:
        attrs[semconv.PLAN_FINGERPRINT] = plan_fingerprint
    if query.insights is not None:
        attrs[semconv.INSIGHTS_WARNINGS] = sum(f.level == "warn" for f in query.insights)
    if diagnostics is not None:
        _add_diagnostics(attrs, diagnostics)
    if include_plan:
        attrs[semconv.PLAN] = plan_json(query)

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
        if node.scan is not None and node.scan.columns_read is not None:
            columns += node.scan.columns_read

    def text(value: str) -> str:
        return _text(value)

    for node in semantic.values():
        if node.scan is not None:
            scans += 1
            if node.scan.source is not None:
                sources.append(text(node.scan.source))
            predicates.extend(text(p) for p in node.scan.predicates)
        elif node.join is not None:
            joins += 1
            if node.join.how is not None:
                join_types.append(node.join.how)
            join_keys.extend(text(key) for key in node.join.left_keys)
        elif node.sort is not None:
            sort_columns.extend(text(column) for column in node.sort.columns)
        elif node.aggregation is not None and node.aggregation.grouped:
            groupbys += 1
            groupby_keys.extend(text(key) for key in node.aggregation.keys)

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
