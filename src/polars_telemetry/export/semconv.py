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

QUERY_ID: Final = "polars.query_id"
ENGINE: Final = "polars.engine"
CPU_MS: Final = "polars.cpu_ms"
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

NODE_KIND: Final = "polars.node.kind"

# May contain file paths, column names or literal values. Documented so that
# exporting to a third-party backend is an informed choice.
CARRIES_USER_DATA: Final[frozenset[str]] = frozenset(
    {SCAN_SOURCES, SCAN_PREDICATES, JOIN_KEYS, GROUPBY_KEYS}
)

# Metric attributes must come from a bounded set: plan literals are unbounded
# and would blow up series cardinality.
METRIC_DIMENSIONS: Final[frozenset[str]] = frozenset({NODE_KIND, ENGINE})
