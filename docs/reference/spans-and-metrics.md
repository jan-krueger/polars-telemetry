# Spans and metrics

Everything the [OpenTelemetry exporter](../exporters/opentelemetry.md) emits.

Names here are public API: renaming one breaks every dashboard built on it.
They are defined in `polars_telemetry.export.semconv`.

## Query span

The span is named `polars.collect`.

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.query_id` | str | UUIDv7 from Polars; time-ordered |
| `polars.query.label` | str | Set with `polars_telemetry.label()`; nested labels joined with `/`. Never a metric dimension |
| `polars.plan.fingerprint` | str | Hash of the plan *shape* — see below |
| `polars.engine` | str | `streaming`, or `in-memory` for eager operations and an explicit `engine="in-memory"`. Absent when the query failed before planning |
| `polars.cpu_ms` | float | Summed node self time; exceeds wall time when parallel |
| `polars.planning_ms` | float | Start to execution: Polars optimising and lowering the plan |
| `polars.telemetry_ms` | float | polars-telemetry's own work before execution |
| `polars.query_metrics.<key>` | int | One per query-level counter Polars sends, under the prefix `polars.query_metrics.` and Polars' own name, such as `polars.query_metrics.io_total_active_ns`: the time any IO of the query was in flight. Absent on Polars versions that send none |
| `polars.parallelism` | float | `cpu_ms / wall_ms` |
| `polars.parallel_efficiency` | float | `cpu_ms / wall_ms / cpu_count`, 0–1 |
| `polars.cpu_count` | int | Threads Polars can use: its pool size, which honours CPU affinity, a container or systemd CPU quota, and `POLARS_MAX_THREADS` |
| `polars.node_count` | int | Physical plan nodes |
| `polars.result.rows` | int | Rows reaching the sink, when reported |

### Call site

Where in your code the query ran, as OpenTelemetry's code attributes; a backend
that supports them links the query to its source.

| Attribute | Type | Notes |
| --- | --- | --- |
| `code.file.path` | str | Absolute path of the innermost frame outside Polars |
| `code.line.number` | int | Line that ran the query |
| `code.function.name` | str | Enclosing function |

Absent when the query came from code with no file on disk — `exec`, the REPL,
or a notebook cell, whose temporary filename changes on every run — and for
`collect_async()` and `collect_batches()`, which Polars reports from its own
threads.

Disable with `Config(call_site=False)`. None of the three is a metric
dimension.

### The fingerprint

A hash of node kinds, topology and column identity — **not** literal values. So
`amount > 10` and `amount > 90` produce the same fingerprint, while a different
grouping column produces a different one. A scanned file counts by its name,
with numbers and dates masked: `data-2024-01-01.parquet` and
`data-2024-01-02.parquet` in any directory are the same shape, `orders.parquet`
is another. It is bounded by your code paths, so it is safe as a metric
dimension; `polars.query_id` is not.

### Hot node

The single most expensive node.

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.hot_node.kind` | str | e.g. `GroupBy`, `EquiJoin` |
| `polars.hot_node.cpu_ms` | float | Its self time |
| `polars.hot_node.share` | float | Fraction of total CPU, 0–1 |

### Diagnostics

Derived from the collected counters. Absent when the plan has no node of the
relevant kind. For what all filters of a shape keep together, divide
`polars.node.rows_out` by `polars.node.rows_in` with `polars.node.kind` set to
`Filter`.

| Attribute | Type | What it tells you |
| --- | --- | --- |
| `polars.join.growth` | float | The largest join's rows out over its larger input, across the plan; above 2 means many-to-many keys |
| `polars.projection.efficiency` | float | Columns read over columns in the file |
| `polars.morsel.skew` | float | The largest of any node's largest morsel over its mean; above 1 is uneven |
| `polars.scan.predicate_pushed` | bool | True if **any** scan filters inside the scan |
| `polars.scan.row_groups_skipped` | bool | Whether parquet row groups were skipped |
| `polars.scan.has_statistics` | bool | Whether the optimiser had table statistics |

### Plan shape

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.scan.count` | int | Number of scan nodes |
| `polars.scan.sources` | str[] | Paths or URIs scanned |
| `polars.scan.predicates` | str[] | Predicates pushed into the scan |
| `polars.scan.columns` | int | Columns actually read, summed across scans |
| `polars.join.count` | int | Number of join nodes |
| `polars.join.types` | str[] | e.g. `INNER`, `LEFT` |
| `polars.join.keys` | str[] | Left-hand join keys |
| `polars.groupby.count` | int | Number of group-by nodes |
| `polars.groupby.keys` | str[] | Grouping expressions |
| `polars.sort.columns` | str[] | Sort expressions |

These are read from the **IR plan**, which keeps your own column names. When
Polars sends no readable IR, they come from the physical plan, whose group-by
keys read `_POLARS_TMP_N`.

### Data quality

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.metrics.complete` | bool | False when the closing snapshot caught unfinished nodes |
| `polars.metrics.incomplete_nodes` | int | How many; only set when non-zero |

When `polars.metrics.complete` is false, every counter below is a **floor**,
not a total — Polars called `close()` before the engine had finished flushing.

### The full plan

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.plan` | str | The whole plan and its counters as JSON |

Off by default; enable with `Config(include_plan=True)`. Kilobytes per span.
The JSON is `{"physical": [...], "logical": [...]}`: each node has `id`,
`kind` and `inputs`; physical nodes add `done`, the counters under the names in
`export.attributes.PLAN_JSON_FIELDS` (times in ms), and from Polars 2 `custom`.

#### Custom node metrics

From Polars 2, a node can report figures about itself. They appear per node as
`custom`, a list of `key`, `unit` (`1` a count, `By` bytes, `ns` a duration)
and `value`, in profiles and in `polars.plan`. The keys Polars 2.0 sends;
others pass through unchanged:

| Key | Unit | What it counts |
| --- | --- | --- |
| `group_by.actual_groups` | 1 | Groups the group-by found |
| `group_by.estimated_groups` | 1 | Groups Polars estimated in advance, to size its tables |

### Insights

One `polars.insight` event per [finding](../insights.md), most important first.
Experimental: rule ids and their texts may change in a minor release; the
attribute names below will not.

| Attribute | Type | Example |
| --- | --- | --- |
| `polars.insights.warnings` | int | `2` (on the span) |
| `polars.insight.rule` | str | `exploding_join` |
| `polars.insight.level` | str | `warn`, `info`, `applied` |
| `polars.node.kind` | str | `EquiJoin` |
| `polars.insight.title` | str | `Join emits 41.3x its larger input` |
| `polars.insight.evidence` | str | `rows_out 12.4M · max_rows_in 301K · growth 41.3x` |
| `polars.insight.fix` | str | ``join on the full key`` |
| `polars.insight.cpu_share` | float | `0.46` |
| `polars.insight.blocked_share` | float | `0.02` |

## Metrics

Query-level, dimensioned by `polars.plan.fingerprint` and `polars.engine`:

| Instrument | Type | Unit |
| --- | --- | --- |
| `polars.query.duration` | histogram | ms |
| `polars.query.cpu_time` | histogram | ms |
| `polars.query.planning_time` | histogram | ms |
| `polars.query.io_time` | histogram | ms |
| `polars.query.parallel_efficiency` | histogram | 1 |

Node-level, dimensioned by `polars.node.kind` and `polars.engine`:

| Instrument | Type | Unit |
| --- | --- | --- |
| `polars.node.cpu_time` | histogram | ms |
| `polars.node.poll_time` | histogram | ms |
| `polars.node.max_poll_time` | histogram | ms |
| `polars.node.state_update_time` | histogram | ms |
| `polars.node.max_state_update_time` | histogram | ms |
| `polars.node.largest_morsel` | histogram | {row} |
| `polars.node.stolen_ratio` | histogram | 1 |
| `polars.node.io_time` | histogram | ms |
| `polars.node.rows_in` | counter | {row} |
| `polars.node.rows_out` | counter | {row} |
| `polars.node.morsels_in` | counter | {morsel} |
| `polars.node.morsels_out` | counter | {morsel} |
| `polars.node.polls` | counter | {poll} |
| `polars.node.state_updates` | counter | {update} |
| `polars.node.io_bytes` | counter | By |

Query-level, dimensioned by `polars.plan.fingerprint`, `polars.insight.rule` and
`polars.insight.level`, all bounded:

| Instrument | Type | Unit |
| --- | --- | --- |
| `polars.query.insights` | counter | {finding} |

It counts `warn` and `info` findings; `applied` ones are span events only.
`polars.engine` is `unknown` when a query failed before planning.

`polars.node.io_bytes`, `polars.node.largest_morsel` and `polars.query.io_time`
carry one extra dimension, `polars.direction`. For bytes its values are
`requested`, `received` and `sent`; for morsels, `received` and `sent`; for
query IO time, `any`, `received` and `sent`. Query IO time counts concurrent
IO once, so `any` is less than the sum of the other two when reads and sends
overlap. It is recorded only on Polars versions that report it.

Every metric dimension is in `semconv.METRIC_DIMENSIONS`, and each is drawn
from a bounded set. Plan literals are **never** metric attributes.

## Attributes that can carry your data

!!! danger "These contain query content"
    `polars.scan.sources` · `polars.scan.predicates` · `polars.join.keys` ·
    `polars.groupby.keys` · `polars.sort.columns`

    `polars.plan` also contains plan detail, when enabled.

A filter on `col("email") == "someone@example.com"` arrives verbatim.
[Data and privacy](../privacy.md) covers how to mask it.
`semconv.CARRIES_USER_DATA` lists these plan attributes; the call site, label
and error status are covered in
[Data and privacy](../privacy.md#what-can-carry-your-data).
