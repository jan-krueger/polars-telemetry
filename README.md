# polars-telemetry

OpenTelemetry instrumentation for [Polars](https://pola.rs) query execution.

One span per query carrying the plan, and per-node counters as metrics, to any
OTLP collector — or a profile file you open in your browser, with no collector
at all.

[![Both plans, per-node counters and diagnostics for one query in the profile viewer](https://raw.githubusercontent.com/jan-krueger/polars-telemetry/main/docs/assets/viewer.png)](https://jan-krueger.github.io/polars-telemetry/viewer/)

> [!IMPORTANT]
> **Unaffiliated with Polars and Polars Cloud.** This package attaches to an
> interface polars exposes for its own cloud product. That interface is
> internal and carries no deprecation guarantee, so it can change or disappear
> in any polars release.
>
> Supported polars: **1.44.1 – 1.44.x**. On anything else the package degrades
> to reduced telemetry with a warning; it will not break your queries.

## Install

```bash
pip install polars-telemetry          # API only; bring your own OTel SDK
pip install 'polars-telemetry[otlp]'  # with SDK and OTLP exporter
```

Python 3.10+.

## Use

```python
import polars_telemetry

polars_telemetry.install()
```

`install()` enables polars' query monitoring, which sets the engine affinity to
`"streaming"` and therefore changes how your queries execute — so it never
happens on import. `uninstall()` reverses it.

## What you get

A `polars.collect` span per query, on whatever trace context was active:

- the plan — scan sources, pushed-down predicates, join types and keys,
  group-by keys
- `polars.cpu_ms`, `polars.parallelism`, result rows
- the hottest node and its share of total CPU
- diagnostics — parallel efficiency, filter selectivity, join amplification,
  projection efficiency, morsel skew, predicate pushdown, row-group skipping

Per-node counters — rows, morsels, polls, work-stealing, poll latency, state
updates, IO time and bytes — as 15 metric instruments dimensioned by node kind.

Every name is listed in the
[attribute reference](https://jan-krueger.github.io/polars-telemetry/attributes/).

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
It runs entirely in your browser; nothing is uploaded.

## Configure

```python
from polars_telemetry import Config

polars_telemetry.install(Config(node_metrics=False))
```

| Option | Default | Effect |
| --- | --- | --- |
| `node_metrics` | `True` | Read per-node counters once at query end |
| `include_plan` | `False` | Attach the full plan to the span as JSON |
| `redact_literals` | `False` | Mask literal values in plan expressions |
| `resource_attributes` | `{}` | Extra resource attributes |

## Your data

Spans carry plan detail: scan paths, column names, join keys and **literal
predicate values** — `col("email") == "..."` arrives verbatim, because knowing
which predicate was slow is usually the point.

- `Config(redact_literals=True)` masks literal values.
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
