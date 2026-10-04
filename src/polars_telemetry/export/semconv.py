"""Attribute and instrument names.

Renaming anything here breaks dashboards built on it; treat as public API.

There are no per-node spans: polars reports cumulative counters and no
timestamps, so a node interval could only be sampled, and sampling proved both
expensive and too coarse to be honest. Node detail is carried as metrics and as
query-span aggregates instead.
"""

from __future__ import annotations

from typing import Final

QUERY_SPAN: Final = "polars.collect"

# OpenTelemetry's own code attributes, so a backend that already understands
# them links a query to its source without knowing anything about polars.
CODE_FILE_PATH: Final = "code.file.path"
CODE_LINE_NUMBER: Final = "code.line.number"
CODE_FUNCTION_NAME: Final = "code.function.name"

QUERY_ID: Final = "polars.query_id"
QUERY_LABEL: Final = "polars.query.label"
"""Set by the application with `label()`. Free-form, so never a metric dimension."""
ENGINE: Final = "polars.engine"
CPU_MS: Final = "polars.cpu_ms"
PLANNING_MS: Final = "polars.planning_ms"
TELEMETRY_MS: Final = "polars.telemetry_ms"
PARALLELISM: Final = "polars.parallelism"
NODE_COUNT: Final = "polars.node_count"
RESULT_ROWS: Final = "polars.result.rows"

HOT_NODE_KIND: Final = "polars.hot_node.kind"
HOT_NODE_CPU_MS: Final = "polars.hot_node.cpu_ms"
HOT_NODE_SHARE: Final = "polars.hot_node.share"
"""Fraction of total CPU in the single most expensive node."""

SCAN_COUNT: Final = "polars.scan.count"
SCAN_SOURCES: Final = "polars.scan.sources"
SCAN_PREDICATES: Final = "polars.scan.predicates"
SCAN_COLUMNS: Final = "polars.scan.columns"
JOIN_COUNT: Final = "polars.join.count"
JOIN_TYPES: Final = "polars.join.types"
JOIN_KEYS: Final = "polars.join.keys"
GROUPBY_COUNT: Final = "polars.groupby.count"
GROUPBY_KEYS: Final = "polars.groupby.keys"

PLAN_FINGERPRINT: Final = "polars.plan.fingerprint"
PLAN: Final = "polars.plan"
"""The full plan as JSON. Opt-in: it is kilobytes and identical per shape."""

PARALLEL_EFFICIENCY: Final = "polars.parallel_efficiency"
CPU_COUNT: Final = "polars.cpu_count"
FILTER_SELECTIVITY: Final = "polars.filter.selectivity"
FILTER_ROWS_DROPPED: Final = "polars.filter.rows_dropped"
JOIN_AMPLIFICATION: Final = "polars.join.amplification"
"""Deprecated: use JOIN_GROWTH. Removed in 0.6.0."""
JOIN_GROWTH: Final = "polars.join.growth"
PROJECTION_EFFICIENCY: Final = "polars.projection.efficiency"
MORSEL_SKEW: Final = "polars.morsel.skew"
SCAN_PREDICATE_PUSHED: Final = "polars.scan.predicate_pushed"
SCAN_ROW_GROUPS_SKIPPED: Final = "polars.scan.row_groups_skipped"
SCAN_HAS_STATISTICS: Final = "polars.scan.has_statistics"
SORT_COLUMNS: Final = "polars.sort.columns"

METRICS_COMPLETE: Final = "polars.metrics.complete"
METRICS_INCOMPLETE_NODES: Final = "polars.metrics.incomplete_nodes"
"""Nodes unfinished at the closing snapshot. Non-zero means counters are a floor."""

NODE_KIND: Final = "polars.node.kind"
DIRECTION: Final = "polars.direction"

INSIGHTS_WARNINGS: Final = "polars.insights.warnings"
INSIGHT_EVENT: Final = "polars.insight"
INSIGHT_RULE: Final = "polars.insight.rule"
INSIGHT_LEVEL: Final = "polars.insight.level"
INSIGHT_TITLE: Final = "polars.insight.title"
INSIGHT_FIX: Final = "polars.insight.fix"
INSIGHT_EVIDENCE: Final = "polars.insight.evidence"
INSIGHT_CPU_SHARE: Final = "polars.insight.cpu_share"
INSIGHT_BLOCKED_SHARE: Final = "polars.insight.blocked_share"

# May contain file paths, column names or literal values. Documented so that
# exporting to a third-party backend is an informed choice.
CARRIES_USER_DATA: Final[frozenset[str]] = frozenset(
    {SCAN_SOURCES, SCAN_PREDICATES, JOIN_KEYS, GROUPBY_KEYS, SORT_COLUMNS}
)

# Metric attributes must come from a bounded set: plan literals are unbounded
# and would blow up series cardinality.
METRIC_DIMENSIONS: Final[frozenset[str]] = frozenset(
    {NODE_KIND, ENGINE, PLAN_FINGERPRINT, DIRECTION, INSIGHT_RULE, INSIGHT_LEVEL}
)
"""Every one is bounded: node kinds and io directions are closed sets, and a
plan fingerprint is bounded by the application's code paths."""

# Instrument names. Public API in the same way attribute names are.
QUERY_DURATION: Final = "polars.query.duration"
QUERY_CPU_TIME: Final = "polars.query.cpu_time"
QUERY_PLANNING_TIME: Final = "polars.query.planning_time"
QUERY_PARALLEL_EFFICIENCY: Final = "polars.query.parallel_efficiency"
NODE_CPU_TIME: Final = "polars.node.cpu_time"
NODE_ROWS_IN: Final = "polars.node.rows_in"
NODE_ROWS_OUT: Final = "polars.node.rows_out"
NODE_MORSELS_IN: Final = "polars.node.morsels_in"
NODE_MORSELS_OUT: Final = "polars.node.morsels_out"
NODE_LARGEST_MORSEL: Final = "polars.node.largest_morsel"
NODE_POLLS: Final = "polars.node.polls"
NODE_STOLEN_RATIO: Final = "polars.node.stolen_ratio"
NODE_POLL_TIME: Final = "polars.node.poll_time"
NODE_MAX_POLL_TIME: Final = "polars.node.max_poll_time"
NODE_STATE_UPDATE_TIME: Final = "polars.node.state_update_time"
NODE_MAX_STATE_UPDATE_TIME: Final = "polars.node.max_state_update_time"
NODE_STATE_UPDATES: Final = "polars.node.state_updates"
NODE_IO_TIME: Final = "polars.node.io_time"
NODE_IO_BYTES: Final = "polars.node.io_bytes"
QUERY_INSIGHTS: Final = "polars.query.insights"
