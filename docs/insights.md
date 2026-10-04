# Insights

`polars-telemetry insights` reads profile files and says what slows their
queries down: an operation that left the streaming engine, a join that
multiplies rows, the same string function run many times on one column.

```console
$ polars-telemetry insights nightly.jsonl
nightly.jsonl · etl/orders  (212.4 s wall, 1,904.0 s CPU, 148 nodes)
  warn  31% wall  Runs on the in-memory engine  [in_memory_fallback, InMemoryMap]
          The streaming engine hands all 12,000,000 input rows to one call, which took
          1.1 min while the pipeline waited. A streaming equivalent, or fewer rows before
          this node, avoids it.
  warn  22% CPU   8 separate str.replace calls on one column  [repeated_string_scan, Select]
          Each call is another pass over the column. Consider str.replace_many; chained
          replacements can depend on their order, so check the result.
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
| `--write OUT` | Write the profiles again with an `insights` field the viewer reads |

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

Findings state what was observed and what it costs. Whether a pattern is
deliberate is for you to judge; the text never says it is a mistake.

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

## Privacy

Finding texts carry numbers and polars' node kinds, never a column name, an
alias or a literal from the plan. Insights read the plan the profile already
holds; nothing else is collected.
