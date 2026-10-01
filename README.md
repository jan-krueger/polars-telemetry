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
from polars_telemetry import Config, SamplingMode

polars_telemetry.install(Config(sampling=SamplingMode.INTERVAL, interval_ms=25))
```

| Mode | Cost | What you get |
| --- | --- | --- |
| `OFF` | none | Query span and plan attributes |
| `FINAL` *(default)* | one snapshot | The above, plus final per-node counters |
| `INTERVAL` | background thread | The above, plus per-node timelines |

Node spans are *sampled*, not traced: polars exposes cumulative counters, not
timestamps, so window edges are accurate to the sampling interval. Every node
span carries `polars.sample_resolution_ms` so this is never mistaken for exact.

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
just dev      # collector + Jaeger, then a sample query
just test
just matrix   # python x polars grid
just canary   # live contract against newest polars
```

See [docs/](docs/) for the architecture and the interface-risk program.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
