# polars-telemetry

OpenTelemetry instrumentation for [Polars](https://pola.rs) query execution.

One span per query carrying the plan, and per-node counters as metrics, to any
OTLP collector — or a profile file you open in your browser, with no collector
at all.

[![Both plans of a TPC-H query, its figures and diagnostics, and a finding on the selected node in the profile viewer](https://raw.githubusercontent.com/jan-krueger/polars-telemetry/main/docs/assets/viewer.png)](https://jan-krueger.github.io/polars-telemetry/viewer/)

> [!IMPORTANT]
> **Unaffiliated with Polars and Polars Cloud.** This package attaches to an
> interface polars exposes for its own cloud product. That interface is
> internal and carries no deprecation guarantee, so it can change or disappear
> in any polars release.
>
> Supported polars: **1.44.1 – 1.44.x**. On anything else the package emits
> less — or declines to install — with a warning; it will not break your queries.

## Install

```bash
pip install polars-telemetry          # API only; bring your own OTel SDK
pip install 'polars-telemetry[otlp]'  # with SDK and OTLP exporter
pip install 'polars-telemetry[datadog]'  # for the DogStatsD exporter
```

Python 3.10+.

## Use

```python
import polars_telemetry

polars_telemetry.install()
```

`install()` enables polars' query monitoring, which sets the engine affinity to
`"streaming"` and therefore changes how your queries execute — so it never
happens on import. `uninstall()` turns monitoring off and puts the previous
affinity back.

## What you get

A `polars.collect` span per query, on whatever trace context was active:

- the plan — scan sources, pushed-down predicates, join types and keys,
  group-by keys
- `polars.cpu_ms`, `polars.parallelism`, result rows
- the hottest node and its share of total CPU
- diagnostics — parallel efficiency, join growth,
  projection efficiency, morsel skew, predicate pushdown, row-group skipping
- the file, line and function that ran the query, as OpenTelemetry's
  `code.*` attributes

Per-node counters — rows, morsels, polls, work-stealing, poll latency, state
updates, IO time and bytes — as 15 metric instruments dimensioned by node kind.

Every name is listed in the
[attribute reference](https://jan-krueger.github.io/polars-telemetry/reference/spans-and-metrics/).

## Where it goes

| Exporter | Sends | To |
| --- | --- | --- |
| `OTelExporter`, the default | a span and per-node metrics | your OpenTelemetry SDK |
| `DogStatsdExporter` | the same metrics, with tags | the Datadog Agent, or Telegraf into InfluxDB |
| `FileExporter` | a profile per query: both plans, every counter | a `.jsonl` file for the viewer |
| `ConsoleExporter` | a short summary | standard error |

```python
from datadog import DogStatsd
from polars_telemetry.export.dogstatsd import DogStatsdExporter

statsd = DogStatsd(disable_buffering=False, disable_background_sender=False)
polars_telemetry.install(exporter=DogStatsdExporter(statsd))
```

`exporter` takes a list, so several can run at once. Each has a
[page in the docs](https://jan-krueger.github.io/polars-telemetry/exporters/),
with its options and what it costs.

## Profiles without a collector

```python
from polars_telemetry.export.file import FileExporter

polars_telemetry.install(exporter=FileExporter("profiles/session.jsonl"))
```

One self-contained JSON document per query: both plans with every node
property, all 19 per-node counters, the diagnostics, and a fingerprint of the
plan shape.

Drop the file on the
[profile viewer](https://jan-krueger.github.io/polars-telemetry/viewer/) to read
both plans, per-node counters, and a diff between two runs of the same shape.
It runs entirely in your browser; nothing is uploaded. To try it without a
workload of your own, open the viewer and load a TPC-H example with one click:
the 22 queries at scale factor 1 or 10, three runs each. The same sessions are
in [`examples/`](examples/).

## Label what runs

```python
with polars_telemetry.label("revenue_by_region"):
    report.collect()
```

The label is on the span and in the profile; nested labels join with `/`.

## Profile a block of code

```python
from polars_telemetry import profile

with profile() as session:
    report = build_report()

session.slowest.call_site  # where the slow one was run
session.write("report.jsonl")  # open in the viewer
```

Installs instrumentation only if nothing was installed. With an application
already instrumented it collects alongside the existing exporter.

## Configure

```python
from polars_telemetry import Config

polars_telemetry.install(Config(node_metrics=False))
```

| Option | Default | Effect |
| --- | --- | --- |
| `node_metrics` | `True` | Read per-node counters once at query end |
| `include_plan` | `False` | Attach the full plan to the span as JSON |
| `call_site` | `True` | Record the file, line and function that ran the query |
| `describe_fallbacks` | `True` | Have polars describe what an in-memory fallback node runs |
| `insights` | `True` | Find what slows each query down; see [Insights](https://jan-krueger.github.io/polars-telemetry/insights/) |
| `redaction` | `None` | What to mask before exporters see a query; `Redaction()` masks literal values |

## Your data

Spans carry plan detail: scan paths, column names, join keys and **literal
predicate values** — `col("email") == "..."` arrives verbatim, because knowing
which predicate was slow is usually the point.

- `Config(redaction=Redaction())` masks literal values: text, numbers, dates
  and times. `Redaction(paths=True, call_site=True, labels=True)` masks more.
- `redacted(exporter, ...)` gives one exporter its own setting, so a shared
  backend can get a masked copy while a local file keeps full detail.
- Literals are never used as metric attributes, at any setting.
- Attributes that can carry user data are listed in
  `polars_telemetry.export.semconv.CARRIES_USER_DATA`.

## Polars Cloud

If `polars-cloud` is installed, its observer is wrapped and forwarded to rather
than replaced. Both work at once.

## Links

- [Documentation](https://jan-krueger.github.io/polars-telemetry/)
- [Contributing](https://github.com/jan-krueger/polars-telemetry/blob/main/CONTRIBUTING.md) — development, testing, releasing
- [Changelog](https://github.com/jan-krueger/polars-telemetry/blob/main/CHANGELOG.md)

## License

Apache-2.0. See [LICENSE](https://github.com/jan-krueger/polars-telemetry/blob/main/LICENSE) and [NOTICE](https://github.com/jan-krueger/polars-telemetry/blob/main/NOTICE).
