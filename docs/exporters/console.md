# Console

A short summary of each query, printed to standard error.

## Use it when

- You are working locally and want to see what each query cost, now.
- You are checking that instrumentation works before wiring up anything else.

## Set up

```python
import polars_telemetry
from polars_telemetry.export.console import ConsoleExporter

polars_telemetry.install(exporter=ConsoleExporter())
```

## What you get

A header with the totals, the call site, and the twelve most expensive nodes:

```text
polars query nightly/revenue_by_region ok wall=20.5ms cpu=81.7ms parallelism=3.99x nodes=6 rows_out=4
  at reports.py:23 in revenue_by_region()
  GroupBy               81.1ms  in=   2,696,064  out=           4
  Sort                  0.29ms  in=           4  out=           4
  SimpleProjection      0.16ms  in=   2,696,064  out=   2,696,064
  MultiScan             0.12ms  in=           0  out=   2,696,064
  InMemorySink            17us  in=           4  out=           0
  SimpleProjection        16us  in=           4  out=           4
```

The header names the query by its [label](../labels.md), or by the start of
its id. A failed query shows `FAILED` and polars' message instead of `ok`.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `stream` | standard error | Any text stream, such as `sys.stdout` or an open file |

## Your data

The label, node kinds, row counts and the call site's file name. No plan
expressions, so no literals.

## Cost

About 10–30 µs per query, plus whatever the stream costs to write to.

## When it fails

A stream that raises, such as a closed file, is logged once, and after five
errors the exporter is disabled for the rest of the process.
