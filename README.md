# polars-telemetry

OpenTelemetry instrumentation for [Polars](https://pola.rs) query execution.
Emits a span per query, a child span per physical plan node, and per-node
metrics — to any OTLP collector.

> [!IMPORTANT]
> **Unaffiliated with Polars and Polars Cloud.** This package attaches to an
> interface polars exposes for its own cloud product. That interface is
> internal and carries no deprecation guarantee, so it can change or disappear
> in any polars release.
>
> Supported polars: **1.44.1 – 1.44.x**. On anything else the package degrades
> to reduced telemetry with a warning; it will not break your queries.

## Status

Pre-release. Nothing is published yet.

## Install

```bash
pip install polars-telemetry          # API only; bring your own OTel SDK
pip install 'polars-telemetry[otlp]'  # with SDK and OTLP exporter
```

## Use

```python
import polars_telemetry

polars_telemetry.install()
```

Activation is explicit and never happens on import: enabling monitoring sets
polars' engine affinity to `"streaming"`, which changes how your queries
execute.

```python
from polars_telemetry import Config

polars_telemetry.install(Config(node_metrics=False))  # query span only
```

## What you get

One span per query, attached to whatever trace context the caller had active,
carrying the plan: scan sources and pushed-down predicates, join types and
keys, group-by keys, result rows, CPU time, parallelism, and the single
hottest node with its share of total CPU.

Per-node counters — self time, rows, morsels, polls, work-stealing ratio, IO
bytes — are emitted as OpenTelemetry **metrics**, dimensioned by node kind.

### Why there are no per-node spans

polars reports cumulative counters and no per-node timestamps, so a node
interval can only be *sampled*. We built that, measured it, and removed it:

- polling cost 5–15% of query wall time at useful intervals,
- and on a 48 ms query, 8 of 11 nodes collapsed onto two identical windows —
  the "timeline" was mostly sampling quantisation.

Read once when the query ends, the same counters are **exact** and cost nothing
measurable. If polars ever exposes per-node timestamps, node spans become
exact and cheap, and they go back in.

Overhead on a 3M-row join-and-aggregate, interleaved against an uninstrumented
baseline on the same engine: within measurement noise.

## Data in your telemetry

Spans include plan detail: scan paths, column names, join keys and **literal
predicate values** — `col("email") == "..."` arrives verbatim. This is
deliberate; knowing which predicate was slow is usually the point.

- `Config(redact_literals=True)` masks literal values if you export to a
  backend you do not control.
- Literals are never used as metric attributes, regardless of that setting —
  unbounded values would destroy metric cardinality.

Attributes that can carry user data are listed in
`polars_telemetry.export.semconv.CARRIES_USER_DATA`.

## Polars Cloud

If `polars-cloud` is installed, its observer is wrapped and forwarded to rather
than replaced. Both work at once.

## Development

```bash
uv sync
just dev      # collector, Jaeger, Prometheus, Grafana + a sample workload
just urls     # where to look
just test
just matrix   # python x polars grid
just canary   # live contract against newest polars
```

`just docs` serves the documentation locally; `just docs-build` builds it the
way CI does.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
