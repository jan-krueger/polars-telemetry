# Insights

Findings on what slows a query down: an operation that left the streaming
engine, a join that multiplies rows, the same string function run many times
on one column. Each finding has a one-line title, its evidence as measured
values, and a fix.

!!! note "Experimental"
    Rules, their ids, titles, fixes and evidence may change in a minor
    release while they are tuned on real workloads.

## From the command line

`polars-telemetry insights` reads, from any version, plain or gzip:

- session files of the [JSONL exporter](exporters/jsonl.md) and `profile()`;
- the finished queries of an [event recording](exporters/events.md).

A damaged line is listed as skipped, with its reason; the rest is still read.

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

- **Detection** uses facts independent of data volume: a ratio, a node kind, a
  count of calls. A small test run shows the findings of the production run it
  stands in for.
- **Impact** is the larger of two shares:
  - **CPU**: of the CPU time charged to plan nodes, the share the finding's
    nodes account for.
  - **Wall**: the share of wall time the pipeline waited on one step of the
    node, for a call that blocks everything behind it.
- **Level**: a **warning** at 1% impact or more, **information** below. Nothing
  is dropped for being small; whether a pattern is deliberate is for you to
  judge.
- **The same finding on several nodes** is one finding: its title ends in
  `(200 nodes)`, its impact is their sum, and `node_ids` lists them. Repeats
  that are each far below 1% warn once together they reach it.

## Rules

### `in_memory_fallback`

```rule
fires: |
  A node the streaming engine cannot run. Polars hands its whole input to the
  in-memory engine in one call, and the pipeline waits for it. Polars marks the
  same nodes in its own plan graph. Common causes: median, quantile or mode in a
  group-by; `rank().over()` before Polars 2.0.
fix: |
  Operations the streaming engine runs natively. With
  `Config(describe_fallbacks=True)`, the default, the node's **Runs** property in
  the viewer shows the expression.
```

### `exploding_join`

```rule
fires: |
  A join that emits more than twice its larger input. A one-to-many join stays
  within both inputs together, so this takes keys that repeat on both sides.
impact: The nodes that process the extra rows.
fix: |
  - Equality join: `unique(subset=keys)` on one input if keys repeat by mistake,
    or join on the full key.
  - Inequality join (`join_where`): an equality key, if rows should only match
    within one.
  - On Polars 2.0 and 2.1, with several joins in the plan: compare with
    `QueryOptFlags(join_order=False)`, as Polars may have chosen an order that
    multiplies rows the written one does not.
measured: |
  - `unique(subset=keys)`: 2–9x faster
  - an equality key in `join_where`: 11–28x
  - `join_order=False`: 16–26x, on a query whose reordered joins multiplied rows
```

### `cross_join`

```rule
fires: |
  A cross join with more than one row on both sides; against a single row it is
  a broadcast and not reported. If a filter follows, the finding says how many
  pairs survive it. Polars turns a cross join with a plain equality or inequality
  filter into a join itself; what is left has a computed condition.
fix: |
  An equality key, or `join_where` with conditions that compare one column from
  each side, such as `x > y - 3`. A computed condition such as
  `abs(x - y) < 3` still builds every pair, in `join_where` too.
measured: "`x > y - 3, x < y + 3` instead of `abs(x - y) < 3`: 30–75x faster on 25M pairs"
```

### `repeated_string_scan`

```rule
fires: |
  `str.contains`, or `str.replace` / `str.replace_all`, called on one column four
  or more times in a node with different arguments, each a separate pass over the
  data. An identical call counts once: Polars computes it once.
fix: |
  - `contains`: `str.contains_any`, or one regular expression, in one pass.
  - `replace`: `str.replace_many` scans once, so a chain merges into it only
    where the result stays the same: no replacement feeds a later pattern
    (`straße → str.` then `. → ""`), and no two patterns overlap (`straße` and
    `ß`), since only one can match. The finding splits the chain, in order, into
    the fewest groups free of both, and names how many `replace_many` calls that
    takes.
notes: |
  The plan does not record `literal=True`, nor `replace` against `replace_all`,
  so the fix holds for literal `replace_all` calls. Patterns that only escape
  punctuation (`\.`) count as literal.
```

### `redundant_aggregation`

```rule
fires: |
  A `unique()`, or a group-by that only keeps values with `first()` or
  `last()`, that removes at most one row in ten thousand.
fix: Drop it if the keys are unique by construction, or deduplicate at the source.
notes: |
  Polars' internal deduplication, such as for `n_unique()`, is not reported: it
  is not the query's to change.
```

### `python_udf`

```rule
fires: |
  A Python function in the plan: `map_elements`, `map_batches` or
  `LazyFrame.map_batches`.
why: |
  Polars cannot look inside it, so nothing is pushed through it, and it runs
  under the GIL. A frame-level function takes the whole input in one call, which
  `longest_step` shows.
fix: Native expressions, or a plugin.
```

### `datetime_format_inferred`

```rule
fires: |
  `str.to_datetime()` or `str.strptime()` without a format: Polars infers one
  from the data, in a separate node.
fix: |
  `format=`. The parse stays inside the expression, and a value in another
  format fails instead of being guessed.
```

### `repeated_subplan`

```rule
fires: |
  The same nodes, with the same inputs, run more than once. Work below a node
  that feeds several consumers is done once and not counted.
why: |
  Polars shares identical subplans itself unless something in them is not
  deterministic; before Polars 2.0 that includes every plugin call, which
  `plugin_calls` counts (see [`repeated_plugin_call`](#repeated_plugin_call)).
  It fires mostly for an expression that one `select` uses for several outputs.
impact: The CPU of every copy but one.
fix: |
  Compute that expression once, as a column with `with_columns`, and refer to the
  column. A LazyFrame used twice: `.cache()` it.
measured: "`with_columns` 2.2–2.4x faster, for 100 quantiles each used twice in one `select`"
```

### `filter_after_scan`

```rule
fires: |
  A filter that keeps at most 10% of its rows, which Polars cannot push into the
  scan, so the scan reads every row first.
fix: |
  | Cause | Why Polars cannot push it | Fix |
  | --- | --- | --- |
  | a `cast` of a column the filter reads | the cast could fail on rows the filter would drop | filter on the stored type first, such as `bin.contains` on a `Binary` column instead of `str.contains` after casting it to `String` |
  | a horizontal concat | `concat(how="horizontal")` lines rows up by position, so filtering one side first changes the result | `with_row_index` on both frames and a `join` on it |
measured: |
  - stored type first: 1.1–3.7x faster on ClickBench's `URL`, `MobilePhoneModel`
    and `SearchPhrase` filters
  - row index and `join`: 1.4–1.7x
```

### `repeated_expression`

```rule
fires: |
  The same sizeable expression computed by two nodes over the same rows, such as
  one that `join_where` evaluates for its condition and again for an aggregate of
  it. Polars shares repeated expressions within a node, not across nodes.
impact: The CPU of the cheaper of the two nodes.
fix: Compute it once, as a column with `with_columns`, and refer to the column.
measured: 1.7–1.8x faster for a distance over 2.25M row pairs
```

### `repeated_plugin_call`

```rule
fires: |
  The same plugin call, on the same input with the same arguments, more than
  once in one node.
fix: |
  | Polars | Plugin calls shared between expressions | Fix |
  | --- | --- | --- |
  | before 2.0, pre-releases included | never ([polars#29165](https://github.com/pola-rs/polars/issues/29165)) | compute the call once and reference the column |
  | 2.0 and later | unless registered with `is_deterministic=False` ([polars#29428](https://github.com/pola-rs/polars/pull/29428)) | register it as deterministic, if it is |
```

## Your data in findings

Numbers, Polars' node kinds and API names only; see
[Data and privacy](privacy.md#what-can-carry-your-data).
