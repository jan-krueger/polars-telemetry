# polars-telemetry

OpenTelemetry instrumentation for [Polars](https://pola.rs) query execution.
One span per query carrying the plan, per-node counters as metrics, to any OTLP
collector — or a profile file you open in your browser, with no collector at
all.

!!! warning "Unaffiliated with Polars and Polars Cloud"
    This package attaches to an interface polars exposes for its own cloud
    product. That interface is internal and carries no deprecation guarantee,
    so it can change or disappear in any polars release. See
    [Compatibility](compatibility.md) for what happens when it does.

```bash
pip install 'polars-telemetry[otlp]'
```

```python
import polars_telemetry

polars_telemetry.install()
```

[Getting started](getting-started.md) covers configuration and wiring up an
exporter.

## What you get

A span named `polars.collect`, attached to whatever trace context was active
when the query ran, carrying:

- the plan — scan sources, pushed-down predicates, join types and keys,
  group-by keys
- `polars.cpu_ms`, `polars.parallelism`, result rows
- the hottest node and its share of total CPU
- diagnostics — parallel efficiency, filter selectivity, join amplification,
  projection efficiency, morsel skew, predicate pushdown, row-group skipping
- the file, line and function that ran the query, as OpenTelemetry's
  `code.*` attributes

Per-node counters — rows, morsels, polls, work-stealing, poll latency, state
updates, IO time and bytes — as 15 metric instruments dimensioned by node kind.

Every name is in the [attribute reference](attributes.md).

There are no per-node spans; polars exposes no per-node timestamps. See
[How it works](how-it-works.md#why-there-are-no-per-node-spans).

## Profiles

The package can write a **profile** per query to a JSON Lines session file —
both plans, every counter and the derived diagnostics, in one self-contained
document of around 10 KB.

```python
from polars_telemetry.export.file import FileExporter

polars_telemetry.install(exporter=FileExporter("profiles/session.jsonl"))
```

Open it in the [profile viewer](viewer/index.html), which runs entirely in your
browser — the file is never uploaded, so profiles keep full plan detail without
leaving the machine that produced them. See [Profiles](profiles.md).

## Overhead

Below measurement noise on a 3M-row join-and-aggregate, interleaved against an
uninstrumented baseline on the same engine. A budget is enforced in CI.
