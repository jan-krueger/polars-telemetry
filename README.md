# polars-telemetry

See what your Polars queries do: timings and row counts for every node of every
query, both plans in a browser viewer, and findings on what slows a query down.
Send the same data to OpenTelemetry or DogStatsD when you want it in your
observability stack.

[![Both plans of a TPC-H query, its figures, and a finding on the selected node in the profile viewer](https://raw.githubusercontent.com/jan-krueger/polars-telemetry/main/docs/assets/viewer.png)](https://jan-krueger.github.io/polars-telemetry/viewer/)

Python 3.10+, polars 1.44.1 – 1.44.x and 2.x. Not affiliated with Polars: it
uses an interface polars exposes for Polars Cloud, which can change in any
polars release.

## Install

```bash
pip install polars-telemetry
```

## Quick start

**1. Profile a block of code**

```python
import polars as pl
import polars_telemetry as pt

orders = pl.LazyFrame({"id": range(200_000), "region": ["EU", "US"] * 100_000})

with pt.profile() as session:
    orders.unique().group_by("region").len().collect()

session.write("profile.jsonl")
```

**2. Open it in the viewer**

Drop `profile.jsonl` on the
[profile viewer](https://jan-krueger.github.io/polars-telemetry/viewer/): both
plans, every node's counters, and the findings. It runs in your browser and
uploads nothing. No profile at hand? The viewer loads the TPC-H queries with one
click.

**3. Find what slows it down**

```console
$ polars-telemetry insights profile.jsonl
profile.jsonl · 01a111e2-ac8d-7fd0-a766-e17ecb2eec7c  (9 ms wall, 32 ms CPU, 9 nodes)
  warn   75% CPU   Deduplication removes no rows  [redundant_aggregation, GroupBy #4294967299]
                   rows_in 200K · rows_removed 0
                   fix: drop the `unique`/`group_by` if keys are unique by construction, or dedup at the source

1 queries: 1 warnings, 0 information, 0 applied
```

`--fail-on warn` exits with 1 on a warning, for CI. Every rule:
[Insights](https://jan-krueger.github.io/polars-telemetry/insights/).

**Or watch every query as it runs**

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

## Send it to your observability stack

| Exporter | Install | Sends |
| --- | --- | --- |
| [OpenTelemetry](https://jan-krueger.github.io/polars-telemetry/exporters/opentelemetry/), the default | `pip install 'polars-telemetry[otlp]'`, then set up the SDK | a span per query, per-node metrics, findings as span events |
| [DogStatsD](https://jan-krueger.github.io/polars-telemetry/exporters/dogstatsd/) | `pip install 'polars-telemetry[datadog]'` | the same metrics, tagged, to the Datadog Agent or Telegraf |
| [JSONL file](https://jan-krueger.github.io/polars-telemetry/exporters/jsonl/) | included | a profile per query, for the viewer and the CLI |
| [Console](https://jan-krueger.github.io/polars-telemetry/exporters/console/) | included | a short summary on standard error |

`pt.install()` without an exporter sends to OpenTelemetry, through the SDK you
configured; `exporter=` takes one exporter or a list. Every span attribute and
metric: [Spans and metrics](https://jan-krueger.github.io/polars-telemetry/reference/spans-and-metrics/).

## Label queries

```python
with pt.label("revenue_by_region"):
    report.collect()
```

Labels name a query in the viewer, the CLI and on spans; nested labels join
with `/`. See [Labels](https://jan-krueger.github.io/polars-telemetry/labels/).

## Configure

```python
pt.install(pt.Config(node_metrics=False))
```

| Option | Default | Effect |
| --- | --- | --- |
| `node_metrics` | `True` | Read per-node counters once at query end |
| `include_plan` | `False` | Attach the full plan to the span as JSON |
| `call_site` | `True` | Record the file, line and function that ran the query |
| `describe_fallbacks` | `True` | Have polars describe what an in-memory fallback node runs |
| `insights` | `True` | Find what slows each query down, as it runs |
| `redaction` | `None` | What to mask before exporters see a query; `Redaction()` masks literal values |

Details: [Configuration](https://jan-krueger.github.io/polars-telemetry/reference/configuration/).

## Your data

Plans are exported as written, **literal values included**, such as
`col("email") == "..."`. `Config(redaction=Redaction())` masks them; metrics
never carry them. URL query strings, which can hold credentials, are masked for
every exporter. Details: [Data and privacy](https://jan-krueger.github.io/polars-telemetry/privacy/).

## Links

- [Documentation](https://jan-krueger.github.io/polars-telemetry/)
- [Troubleshooting](https://jan-krueger.github.io/polars-telemetry/troubleshooting/)
- [Polars Cloud](https://jan-krueger.github.io/polars-telemetry/polars-cloud/): runs alongside it
- [Contributing](https://github.com/jan-krueger/polars-telemetry/blob/main/CONTRIBUTING.md)
- [Changelog](https://github.com/jan-krueger/polars-telemetry/blob/main/CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](https://github.com/jan-krueger/polars-telemetry/blob/main/LICENSE) and [NOTICE](https://github.com/jan-krueger/polars-telemetry/blob/main/NOTICE).
