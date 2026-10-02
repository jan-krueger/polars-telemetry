# Attribute reference

Names here are public API: renaming one breaks every dashboard built on it.
They are defined in `polars_telemetry.export.semconv`, and a test asserts this
page documents every one of them.

## Query span

The span is named `polars.collect`.

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.query_id` | str | UUIDv7 from polars; time-ordered |
| `polars.engine` | str | Always `streaming` while monitoring is on |
| `polars.cpu_ms` | float | Summed node self time; exceeds wall time when parallel |
| `polars.parallelism` | float | `cpu_ms / wall_ms` |
| `polars.node_count` | int | Physical plan nodes |
| `polars.result.rows` | int | Rows reaching the sink, when reported |

### Hot node

The single most expensive node, which is usually the whole answer.

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.hot_node.kind` | str | e.g. `GroupBy`, `EquiJoin` |
| `polars.hot_node.cpu_ms` | float | Its self time |
| `polars.hot_node.share` | float | Fraction of total CPU, 0–1 |

### Plan shape

| Attribute | Type | Notes |
| --- | --- | --- |
| `polars.scan.count` | int | Number of scan nodes |
| `polars.scan.sources` | str[] | Paths or URIs scanned |
| `polars.scan.predicates` | str[] | Predicates pushed into the scan |
| `polars.scan.columns` | int | Columns projected from files |
| `polars.join.count` | int | Number of join nodes |
| `polars.join.types` | str[] | e.g. `INNER`, `LEFT` |
| `polars.join.keys` | str[] | Left-hand join keys |
| `polars.groupby.count` | int | Number of group-by nodes |
| `polars.groupby.keys` | str[] | Grouping expressions |

These are read from the **IR plan**, which keeps your own column names. The
physical plan rewrites group-by keys and aggregations to `_POLARS_TMP_N`, so
reading them from there would be useless to a human.

## Metrics

| Instrument | Type | Unit |
| --- | --- | --- |
| `polars.query.duration` | histogram | ms |
| `polars.node.cpu_time` | histogram | ms |
| `polars.node.rows` | counter | rows |

Dimensions are drawn from a closed set — `polars.node.kind` and
`polars.engine`. Plan literals are **never** metric attributes: their values
are unbounded and would destroy series cardinality.

## Attributes that can carry your data

!!! danger "These contain query content"
    `polars.scan.sources` · `polars.scan.predicates` · `polars.join.keys` ·
    `polars.groupby.keys`

A filter on `col("email") == "someone@example.com"` arrives verbatim. This is
deliberate — knowing *which* predicate was slow is usually the point, and
traces are already sensitive telemetry.

Set `Config(redact_literals=True)` to mask literal values while keeping
structure and column names:

```text
col("email") == "someone@example.com"   ->   col("email") == "<str>"
col("amount") > 60.0                    ->   col("amount") > <num>
```

Redaction is best-effort over polars' textual expression form. Use it when
exporting to a backend you do not control; it is not a compliance boundary.

The authoritative list is `polars_telemetry.export.semconv.CARRIES_USER_DATA`.
