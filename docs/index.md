# polars-telemetry

OpenTelemetry instrumentation for [Polars](https://pola.rs) query execution.
One span per query, carrying the plan; per-node counters as metrics; exported
to any OTLP collector.

!!! warning "Unaffiliated with Polars and Polars Cloud"
    This package attaches to an interface polars exposes for its own cloud
    product. That interface is internal and carries no deprecation guarantee,
    so it can change or disappear in any polars release. See
    [Compatibility](compatibility.md) for what happens when it does.

## What you get

A span named `polars.collect`, attached to whatever trace context was active
when the query ran, carrying:

- the query's plan — scan sources, pushed-down predicates, join types and keys,
  group-by keys
- `polars.cpu_ms` and `polars.parallelism`
- the hottest node and its share of total CPU, which is usually the answer to
  "why was this slow"

Plus OpenTelemetry metrics for per-node counters — self time, rows, morsels,
polls, work-stealing ratio, IO bytes — dimensioned by node kind.

## What you do not get

Per-node spans. polars reports cumulative counters and no per-node timestamps,
so a node interval can only be sampled, and sampling measured badly on both
axes. See [How it works](how-it-works.md#why-there-are-no-per-node-spans).

## Profiles

Beyond OTLP, the package can write a **profile** per query to a JSON Lines
session file — the full plan, every counter and the derived diagnostics, in one
self-contained document of around 10 KB.

```python
from polars_telemetry.export.file import FileExporter

polars_telemetry.install(exporter=FileExporter("profiles/session.jsonl"))
```

Open the file in the [profile viewer](viewer/index.html), which runs entirely in your
browser: the file is never uploaded, so profiles keep full plan detail without
leaving the machine that produced them. See [Profiles](profiles.md).

## Overhead

Below measurement noise on a 3M-row join-and-aggregate, interleaved against an
uninstrumented baseline on the same engine. A budget is enforced in CI.
