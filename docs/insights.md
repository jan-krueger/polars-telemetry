# Insights

Findings on what slows a query down: an operation that left the streaming
engine, a join that multiplies rows, the same string function run many times
on one column. Each finding has a one-line title, its evidence as measured
values, and a fix.

!!! note "Experimental"
    Rules, their ids, titles, fixes and evidence may change in a minor
    release while they are tuned on real workloads.

## From the command line

`polars-telemetry insights` reads the session files the
[JSONL exporter](exporters/jsonl.md) and `profile()` write, from any version,
plain or gzip, and the finished queries of an [event recording](exporters/events.md). A damaged line
is listed as skipped, with the reason, and the rest of the file is still read:

```console
$ polars-telemetry insights nightly.jsonl
nightly.jsonl · etl/orders  (54 ms wall, 411 ms CPU, 6 nodes)
  warn   88% CPU   8x `str.replace` on one column, one pass each  [repeated_string_scan, Select #4294967298]
                   calls 8 · columns 1 · replace_many_calls 1
                   fix: if these are literal `replace_all`: merge into one `str.replace_many`
  warn   15% wall  Deduplication removes no rows  [redundant_aggregation, GroupBy #4294967300]
                   rows_in 500K · rows_removed 0
                   fix: drop the `unique`/`group_by` if keys are unique by construction, or dedup at the source

1 query: 2 warnings, 0 information
```

| Option | Effect |
| --- | --- |
| `--all` | List information-level findings too; by default they are counted per rule |
| `--format json` | A JSON array, one object per query: `file`, `query_id`, `label`, `parent_query_id`, `wall_ms`, `insights` |
| `--fail-on warn` / `--fail-on info` | Exit with 1 when a finding reaches that level, for CI. A file that cannot be opened exits with 2 |
| `--write OUT` | Write the profiles again with an [`insights` field](exporters/jsonl.md#what-you-get) the [viewer](profile-viewer.md#findings) shows; other lines are copied unchanged |

## In your application

With `Config(insights=True)`, the default, the same rules run on every query
as it finishes, and the findings go to every exporter:

| Where | What |
| --- | --- |
| OpenTelemetry | a `polars.insight` event per finding and `polars.insights.warnings` on the span; see [Spans and metrics](reference/spans-and-metrics.md#insights) |
| Metrics, also DogStatsD | `polars.query.insights`, counted by rule and level; see [Metrics](reference/spans-and-metrics.md#metrics) |
| Console | each warning, with its evidence and fix |
| JSONL | the `insights` field of each profile |
| Viewer | a badge on each flagged node, and the findings in its details; see [Findings](profile-viewer.md#findings) |

## How findings are ranked

Rules detect facts independent of data volume: a ratio, a node kind, a count
of calls. A small test run shows the same findings as the production run it
stands in for.

How much a finding matters is its **impact**, the larger of two shares:

- **CPU**: the share of the CPU time charged to plan nodes that the finding's
  nodes account for.
- **Wall**: the share of wall time the pipeline waited on one step of the
  node, for a call that blocks everything behind it.

At 1% or more a finding is a **warning**, below that **information**. Nothing
is dropped for being small. Whether a pattern is deliberate is for you to
judge.

The same finding on several nodes, such as one fallback repeated for each of
200 columns, is reported once: its title ends in `(200 nodes)`, its impact is
their sum, and `node_ids` lists them. A step repeated many times is a warning
when the repeats together reach 1%, though each alone is far below.

## Rules

### `in_memory_fallback`

A node the streaming engine cannot run: Polars hands its whole input to the
in-memory engine in one call, and the pipeline waits for it. Polars marks the
same nodes in its own plan graph. Common causes: median, quantile or mode in a
group-by, and before Polars 2.0 `rank().over()`. With
`Config(describe_fallbacks=True)`, the default, the node's **Runs** property in
the viewer shows the expression.

### `exploding_join`

A join that emits more than twice its larger input. A one-to-many join stays
within both inputs together, so this takes keys that repeat on both sides.
Impact counts the nodes that process the extra rows. For an inequality join
(`join_where`), the fix is an equality key, if rows should only match within
one. From Polars 2.0, when the plan has several joins, the fix also suggests
comparing with `QueryOptFlags(join_order=False)`: Polars may have chosen a join
order that multiplies rows the written order does not.

### `cross_join`

A cross join where both sides have more than one row; one against a single row
is a broadcast and not reported. If a filter follows, the finding says how many
pairs survive; an equality key or `join_where` usually avoids building them.

### `repeated_string_scan`

`str.contains`, or `str.replace` / `str.replace_all`, called on one column four
or more times within a node with different arguments, each call a separate pass
over the data. An identical call counts once: Polars computes it once.
`str.contains_any` or one regular expression replaces many `contains` with one
pass.

`str.replace_many` scans once, so a chain of replacements merges into it only
where that gives the same result:

- no replacement feeds a later pattern (`straße → str.` then `. → ""`);
- no two patterns overlap (`straße` and `ß`), since only one can match.

The finding splits the chain, in order, into the fewest groups free of both,
and its fix names how many `replace_many` calls that takes. Polars does not
record `literal=True` or `replace` against `replace_all` in the plan, so the fix
holds for literal `replace_all` calls; patterns that only escape punctuation
(`\.`) count as literal.

### `redundant_aggregation`

A deduplication, a `unique()` or a group-by that only keeps values with
`first()` or `last()`, that removes at most one row in ten thousand. Only
deduplication the query asks for is reported; Polars' internal deduplication,
such as for `n_unique()`, is not the query's to change.

### `python_udf`

A Python function in the plan: `map_elements`, `map_batches` or
`LazyFrame.map_batches`. Polars cannot look inside it, so nothing is pushed
through it; it runs under the GIL. A frame-level function also takes the
whole input in one call, which `longest_step` shows.

### `datetime_format_inferred`

`str.to_datetime()` or `str.strptime()` without a format. Polars infers one from
the data in a separate node; with `format=` the parse stays inside the
expression, and a value in another format fails instead of guessing.

### `repeated_subplan`

The same nodes, with the same inputs, run more than once. Work below a node
that feeds several consumers is done once and not counted. Impact is the CPU of
every copy but one. Polars shares identical subplans itself unless something
in them is not deterministic; before Polars 2.0 that includes every plugin
call, which `plugin_calls` counts (see [`repeated_plugin_call`](#repeated_plugin_call)).
It fires mostly for an expression that one `select` uses for several outputs:
compute it once as a column with `with_columns` and refer to that column.

### `filter_after_scan`

A filter that keeps at most 10% of its rows, which Polars cannot push into the
scan for one of two reasons, so the scan reads every row first:

- **A `cast` of a column the filter reads.** Polars keeps the cast before the
  filter, as the cast could fail on rows the filter would drop. Filter on the
  stored type first, such as `bin.contains` on a `Binary` column instead of
  `str.contains` after casting it to `String`: 2.4x faster on ClickBench's
  `MobilePhoneModel` filter and 3.7x on its `URL` filter.
- **A horizontal concat.** `concat(how="horizontal")` lines rows up by
  position, so filtering one side first would change the result. Add the
  columns with `with_row_index` on both frames and a `join` on it instead.

### `repeated_plugin_call`

The same plugin call, on the same input with the same arguments, more than once
in one node.

| Polars | Plugin calls shared between expressions | Fix |
| --- | --- | --- |
| before 2.0, pre-releases included | never ([polars#29165](https://github.com/pola-rs/polars/issues/29165)) | compute the call once and reference the column |
| 2.0 and later | unless registered with `is_deterministic=False` ([polars#29428](https://github.com/pola-rs/polars/pull/29428)) | register it as deterministic, if it is |

## Your data in findings

Numbers, Polars' node kinds and API names only; see
[Data and privacy](privacy.md#what-can-carry-your-data).
