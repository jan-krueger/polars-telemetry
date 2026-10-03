# Spans and metrics

Everything the [OpenTelemetry exporter](../exporters/opentelemetry.md) emits.

Names here are public API: renaming one breaks every dashboard built on it.
They are defined in `polars_telemetry.export.semconv`, and a test asserts this
page documents every one of them.

## Query span

The span is named `polars.collect`.

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.query_id` | str | UUIDv7 from polars; time-ordered |
| `polars.query.label` | str | Set with `polars_telemetry.label()`; nested labels joined with `/`. Never a metric dimension |
| `polars.plan.fingerprint` | str | Hash of the plan *shape* — see below |
| `polars.engine` | str | `streaming`, or `in-memory` for eager operations and an explicit `engine="in-memory"`. Absent when the query failed before planning |
| `polars.cpu_ms` | float | Summed node self time; exceeds wall time when parallel |
| `polars.parallelism` | float | `cpu_ms / wall_ms` |
| `polars.parallel_efficiency` | float | `cpu_ms / wall_ms / cpu_count`, 0–1 |
| `polars.cpu_count` | int | Cores visible to the process |
| `polars.node_count` | int | Physical plan nodes |
| `polars.result.rows` | int | Rows reaching the sink, when reported |

### Call site

Where in your code the query ran, under OpenTelemetry's own code attributes, so
a backend that already understands them links a query to its source.

| Attribute | Type | Notes |
| --- | --- | --- |
| `code.file.path` | str | Absolute path of the innermost frame outside polars |
| `code.line.number` | int | Line that ran the query |
| `code.function.name` | str | Enclosing function |

Absent when the query came from code with no file on disk — `exec`, the REPL,
or a notebook cell, whose temporary filename changes on every run.

This is the identity a person can act on. The fingerprint groups runs of the
same plan but is a hash, and it changes whenever polars changes its optimiser;
`pipeline.py:142` does not. Disable with `Config(call_site=False)`.

None of the three is a metric dimension: a line number changes whenever the
file above it is edited, which would restart every series on an unrelated edit.

### The fingerprint

A hash of node kinds, topology and column identity — **not** literal values. So
`amount > 10` and `amount > 90` produce the same fingerprint, while a different
grouping column produces a different one. It is bounded by your code paths,
which is what makes it safe as a metric dimension where `polars.query_id` is not.

### Hot node

The single most expensive node, which is usually the whole answer.

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.hot_node.kind` | str | e.g. `GroupBy`, `EquiJoin` |
| `polars.hot_node.cpu_ms` | float | Its self time |
| `polars.hot_node.share` | float | Fraction of total CPU, 0–1 |

### Diagnostics

Derived from counters already collected. Absent when the plan has no node of
the relevant kind.

| Attribute | Type | What it tells you |
| --- | --- | --- |
| `polars.filter.selectivity` | float | Rows surviving the filter, 0–1 |
| `polars.filter.rows_dropped` | int | Rows removed before the rest of the plan |
| `polars.join.amplification` | float | Rows out over probe-side rows in; above 1 is fan-out |
| `polars.projection.efficiency` | float | Columns read over columns in the file |
| `polars.morsel.skew` | float | Largest morsel over the mean; above 1 is uneven |
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

These are read from the **IR plan**, which keeps your own column names. The
physical plan rewrites group-by keys and aggregations to `_POLARS_TMP_N`, so
reading them from there would be useless to a human.

### Data quality

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.metrics.complete` | bool | False when the closing snapshot caught unfinished nodes |
| `polars.metrics.incomplete_nodes` | int | How many; only set when non-zero |

When `polars.metrics.complete` is false, every counter below is a **floor**,
not a total — polars called `close()` before the engine had finished flushing.

### The full plan

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.plan` | str | The whole plan and its counters as JSON |

Off by default — it is kilobytes per span and identical for every run of a
shape. Enable with `Config(include_plan=True)` when you want the topology,
which nothing else carries. Contains both the physical and IR node lists with
`id`, `kind` and `inputs`, plus every per-node counter.

## Metrics

Query-level, dimensioned by `polars.plan.fingerprint` and `polars.engine`:

| Instrument | Type | Unit |
| --- | --- | --- |
| `polars.query.duration` | histogram | ms |
| `polars.query.cpu_time` | histogram | ms |
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

`polars.node.io_bytes` and `polars.node.largest_morsel` carry one extra
dimension, `polars.direction`. For bytes its values are `requested`,
`received` and `sent`; for morsels, `received` and `sent`.

Every metric dimension is drawn from a bounded set — node kinds, io directions,
engine, and the plan fingerprint. Plan literals are **never** metric
attributes: their values are unbounded and would destroy series cardinality.

## Attributes that can carry your data

!!! danger "These contain query content"
    `polars.scan.sources` · `polars.scan.predicates` · `polars.join.keys` ·
    `polars.groupby.keys`

    `polars.plan` also contains plan detail, when enabled.

A filter on `col("email") == "someone@example.com"` arrives verbatim.
[Data and privacy](../privacy.md) covers how to mask it. The authoritative list
is `polars_telemetry.export.semconv.CARRIES_USER_DATA`.
