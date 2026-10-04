# Insights

`polars-telemetry insights` reads profile files and says what slows their
queries down: an operation that left the streaming engine, a join that
multiplies rows, the same string function run many times on one column.

```console
$ polars-telemetry insights nightly.jsonl
nightly.jsonl · etl/orders  (212.4 s wall, 1,904.0 s CPU, 148 nodes)
  warn   31% wall  In-memory fallback: all input rows in one call  [in_memory_fallback, InMemoryMap #41]
                   rows_in 12M · longest_step 1.1 min
                   fix: use a streaming-native expression, or reduce rows before this node
  warn   22% CPU   8x `str.replace` on one column, one pass each  [repeated_string_scan, Select #17]
                   calls 8 · columns 1
                   fix: merge into one `str.replace_many`; chained replacements can depend on order
  3 more as information: redundant_aggregation x3 (--all lists them)

1 queries: 2 warnings, 3 information, 0 applied
```

It reads the session files the [JSONL exporter](exporters/jsonl.md) and
`profile()` write, from any version.

## Options

| Option | Effect |
| --- | --- |
| `--all` | List information-level findings too; by default they are counted per rule |
| `--format json` | One record per query, with every finding |
| `--fail-on warn` / `--fail-on info` | Exit with 1 when a finding reaches that level, for CI |
| `--write OUT` | Write the profiles again with an `insights` field the [viewer](profile-viewer.md#findings) shows |

## How findings are ranked

Every rule detects a fact that does not depend on how much data ran: a ratio,
a node kind, a count of calls. A small test run therefore shows the same
findings as the production run it stands in for.

How much a finding matters is its **impact**, the larger of two shares:

- **CPU**: the share of the query's CPU time spent on the nodes it concerns.
- **Wall**: the share of wall time the pipeline waited on one step of the
  node, for a call that blocks everything behind it.

At 1% or more a finding is a **warning**, below that **information**. Nothing
is dropped for being small. polars 1.44 does not charge all of a query's time
to its nodes, so read shares as relative within a query.

Each finding is a one-line title, its evidence as measured values, and a fix.
Whether a pattern is deliberate is for you to judge.

## Rules

### `in_memory_fallback`

A node the streaming engine cannot run: polars hands its whole input to the
in-memory engine, in one call, and the pipeline waits for it. polars marks the
same nodes in its own plan graph. `rank().over()` and median in a group-by are
common causes. With `Config(describe_fallbacks=True)`, the default, the node's
**Runs** property in the viewer shows the expression.

### `exploding_join`

A join that emits more than twice its larger input. A one-to-many join stays
within both inputs together, so this takes keys that repeat on both sides.
Its impact counts the nodes that process the extra rows.

### `cross_join`

A cross join where both sides have more than one row. When a filter follows
it, the finding says how many of the pairs survive; an equality key or
`join_where` usually avoids building them. A cross join against a single row
is a broadcast and not reported.

### `repeated_string_scan`

The same `str.*` function called on one column four or more times within a
node, each call another pass over the data. `str.replace_many`,
`str.contains_any` or one regular expression can do the work in one pass.

### `redundant_aggregation`

A deduplication, a `unique()` or a group-by that only keeps values with
`first()` or `last()`, that removes at most one row in ten thousand. Reported
only when the query asks for deduplication itself: polars also deduplicates
internally, for `n_unique()` for one, and that is not the query's to change.

### `python_udf`

A Python function in the plan: `map_elements`, `map_batches` or
`LazyFrame.map_batches`. polars cannot look inside it, so nothing is pushed
through it, and it runs under the GIL. A frame-level function also takes the
whole input in one call, which `longest_step` shows.

### `datetime_format_inferred`

`str.to_datetime()` or `str.strptime()` without a format. polars infers one from
the data in a separate node; with `format=` the parse stays inside the
expression, and a value in another format fails instead of guessing.

### `repeated_subplan`

The same nodes, with the same inputs, run more than once. Work below a node
that feeds several consumers is done once and not counted. Impact is the CPU of
every copy but one. polars shares identical subplans itself unless something
in them is not deterministic; on polars 1.41 to 1.44 that includes every
plugin call, which `plugin_calls` counts. Whether a copy is deliberate is for
you to judge.

### `repeated_plugin_call`

The same plugin call, on the same input with the same arguments, more than once
in one node. polars 1.41 to 1.44 never shares plugin calls between expressions
([polars#29165](https://github.com/pola-rs/polars/issues/29165)); the fix,
[polars#29428](https://github.com/pola-rs/polars/pull/29428), is not yet in a
release. Until then, compute the call once and reference the column.

## Privacy

Findings carry numbers, polars' node kinds and API names, never a column
name, an alias or a literal from the plan. Insights read the plan the profile already
holds; nothing else is collected.
