# Getting started

## Install

```bash
pip install polars-telemetry
```

Python 3.10+; supported polars versions: [Compatibility](internals/compatibility.md).

## 1. Profile a block of code

```python
import polars as pl
import polars_telemetry as pt

orders = pl.LazyFrame({"id": range(200_000), "region": ["EU", "US"] * 100_000})

with pt.profile() as session:
    orders.unique().group_by("region").len().collect()

session.write("profile.jsonl")
```

`profile()` collects every query the block runs; `session.slowest` is the
longest one. See [Labels](labels.md#scope-a-block-of-code).

## 2. Open it in the viewer

Drop `profile.jsonl` on the [profile viewer](profile-viewer.md): both plans,
every node's counters, and the findings. It runs in your browser and uploads
nothing.

## 3. Find what slows it down

```console
$ polars-telemetry insights profile.jsonl
profile.jsonl · 01a111e2-ac8d-7fd0-a766-e17ecb2eec7c  (9 ms wall, 32 ms CPU, 9 nodes)
  warn   75% CPU   Deduplication removes no rows  [redundant_aggregation, GroupBy #4294967299]
                   rows_in 200K · rows_removed 0
                   fix: drop the `unique`/`group_by` if keys are unique by construction, or dedup at the source

1 queries: 1 warnings, 0 information, 0 applied
```

Options, and every rule: [Insights](insights.md).

## Watch every query as it runs

`install()` instruments every query in the process. The console exporter needs
no other setup:

```python
import polars as pl
import polars_telemetry as pt
from polars_telemetry.export.console import ConsoleExporter

pt.install(exporter=ConsoleExporter())

orders = pl.LazyFrame({"region": ["EU", "US", "EU"], "amount": [10, 20, 30]})
orders.group_by("region").agg(pl.col("amount").sum()).collect()
```

```text
polars query 1a8cfdfd ok wall=1.92ms planning=0.47ms cpu=1.57ms parallelism=0.82x nodes=5 rows_out=2
  at report.py:8 in <module>()
  GroupBy               0.89ms  in=           3  out=           2
  InMemorySource        0.52ms  in=           0  out=           3
  SimpleProjection        74us  in=           3  out=           3
  InMemorySink            61us  in=           2  out=           0
  SimpleProjection        23us  in=           2  out=           2
```

`install()` returns what was installed, or `None` when this polars cannot be
instrumented:

```python
state = pt.install()
if state is None:
    ...  # see the logged warning
else:
    print(state.capabilities.polars_version, state.capabilities.node_metrics_usable)
```

On polars 1.44, `install()` switches lazy queries to the streaming engine:
[Queries run differently after install()](troubleshooting.md#queries-run-differently-after-install).

## Where next

- Send queries to OpenTelemetry, DogStatsD or a file: [Exporters](exporters/index.md)
- Name queries: [Labels](labels.md)
- Mask literal values before export: [Data and privacy](privacy.md)
- Change what is recorded: [Configuration](reference/configuration.md)
- Something missing: [Troubleshooting](troubleshooting.md)
