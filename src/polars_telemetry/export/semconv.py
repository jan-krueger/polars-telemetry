"""Attribute and instrument naming.

Two rules that are not style preferences:

1. **Plan literals go on spans only.** A predicate like
   ``col("email") == "..."`` is useful on a span and is a cardinality bomb as a
   metric dimension. Metric attributes come from the closed set below.
2. **Names are stable.** Renaming an attribute breaks every dashboard built on
   it, so changes here are breaking changes.
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
SAMPLE_RESOLUTION_MS: Final = "polars.sample_resolution_ms"
"""Error bar on every node span's start and end. Always set when node spans are on."""

NODE_ID: Final = "polars.node.id"
NODE_KIND: Final = "polars.node.kind"
NODE_CPU_MS: Final = "polars.node.cpu_ms"
NODE_ROWS_IN: Final = "polars.node.rows_in"
NODE_ROWS_OUT: Final = "polars.node.rows_out"
NODE_STOLEN_RATIO: Final = "polars.node.stolen_ratio"

SCAN_SOURCE: Final = "polars.scan.source"
SCAN_PREDICATE: Final = "polars.scan.predicate"
SCAN_COLUMNS: Final = "polars.scan.columns"
JOIN_HOW: Final = "polars.join.how"
JOIN_LEFT_ON: Final = "polars.join.left_on"
GROUPBY_KEYS: Final = "polars.groupby.keys"
GROUPBY_AGGS: Final = "polars.groupby.aggs"

CARRIES_USER_DATA: Final[frozenset[str]] = frozenset(
    {SCAN_SOURCE, SCAN_PREDICATE, JOIN_LEFT_ON, GROUPBY_KEYS}
)
"""Attributes that can contain file paths, column names or literal values.

Documented so that exporting to a third-party backend is an informed choice.
``Config.redact_literals`` masks the literal values within these.
"""

METRIC_DIMENSIONS: Final[frozenset[str]] = frozenset({NODE_KIND, ENGINE})
"""The only attributes permitted on metric instruments. Bounded by construction."""
