# Console

A short summary of each query, printed to standard error. Needs nothing beyond
`polars-telemetry`.

## Set up

```python
import polars_telemetry as pt
from polars_telemetry.export.console import ConsoleExporter

pt.install(exporter=ConsoleExporter())
```

## What you get

A header with the totals, the call site, the most expensive nodes, and each
warning [finding](../insights.md) with its evidence and fix:

```text
polars query orders_by_region ok wall=10.2ms planning=0.86ms cpu=35.8ms parallelism=3.53x nodes=9 rows_out=2
  at console_warn.py:9 in <module>()
  GroupBy               24.8ms  in=     200,000  out=     200,000
  GroupBy               10.2ms  in=     200,000  out=           2
  InMemorySource        0.61ms  in=           0  out=     200,000
  SimpleProjection        63us  in=     200,000  out=     200,000
  SimpleProjection        49us  in=     200,000  out=     200,000
  InMemorySink            34us  in=           2  out=           0
  SimpleProjection        29us  in=     200,000  out=     200,000
  SimpleProjection        28us  in=           2  out=           2
  SimpleProjection        26us  in=     200,000  out=     200,000
  warn  Deduplication removes no rows  [redundant_aggregation, GroupBy #4294967299]
        rows_in 200K · rows_removed 0
        fix: drop the `unique`/`group_by` if keys are unique by construction, or dedup at the source
```

The header names the query by its [label](../labels.md), or by the end of its
id. A failed query shows `FAILED` and Polars' message instead of `ok`.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `stream` | standard error | Any text stream, such as `sys.stdout` or an open file |

## Your data

The label, node kinds, row counts, the call site's file name, and on failure
Polars' message, which can quote values. See [Data and privacy](../privacy.md).

## Cost

About 10–30 µs per query, plus whatever the stream costs to write to.

## When it fails

A stream that raises, such as a closed file, is handled as for
[every exporter](index.md#failures-stay-contained).
