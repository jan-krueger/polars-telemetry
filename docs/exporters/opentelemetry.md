# OpenTelemetry

One span per query and per-node metrics, sent wherever your OpenTelemetry SDK
sends them.

## Use it when

- You run polars in a service or pipeline that already reports to
  OpenTelemetry, and want queries in the same traces.
- You want dashboards and alerts on query time across many runs.

## Set up

The package depends on the OpenTelemetry API only. Your application installs
the SDK and decides where data goes; `polars-telemetry[otlp]` adds the SDK and
the OTLP exporter.

```bash
pip install 'polars-telemetry[otlp]'
```

```python
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

tracer_provider = TracerProvider()
tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(tracer_provider)
metrics.set_meter_provider(
    MeterProvider(metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())])
)

import polars_telemetry

polars_telemetry.install()  # OpenTelemetry is the default exporter
```

To combine it with another exporter, pass it explicitly:
`exporter=[OTelExporter(config), ...]`.

## What you get

A span named `polars.collect`, a child of whatever span was active when the
query ran. For a group-by over a filtered parquet scan:

```text
polars.collect
  polars.query.label          nightly/revenue_by_region
  polars.engine               streaming
  polars.plan.fingerprint     f7d144838d88
  code.file.path              /srv/app/reports.py
  code.line.number            23
  code.function.name          revenue_by_region
  polars.cpu_ms               81.714
  polars.parallelism          3.987
  polars.result.rows          4
  polars.hot_node.kind        GroupBy
  polars.hot_node.share       0.9925
  polars.scan.sources         ["orders.parquet"]
  polars.scan.predicates      ["col(\"amount\") > 100.0"]
  polars.scan.predicate_pushed  true
  polars.groupby.keys         ["col(\"region\")"]
  ...
```

The span's status is `ERROR` with polars' message when the query failed. There
are no child spans per node: polars reports no per-node timestamps.

Metrics: three per query (`polars.query.duration`, `polars.query.cpu_time`,
`polars.query.parallel_efficiency`) by plan fingerprint and engine, and fifteen
per node by node kind. Every name and unit is in
[Spans and metrics](../reference/spans-and-metrics.md).

## Options

Through `Config`, passed to both `install()` and `OTelExporter`:

| Option | Default | Effect here |
| --- | --- | --- |
| `node_metrics` | `True` | Per-node counters and all that comes from them: node metrics, `polars.cpu_ms`, the hot node, most diagnostics |
| `include_plan` | `False` | The whole plan as JSON in `polars.plan` |
| `call_site` | `True` | The `code.*` attributes |
| `redact_literals` | `False` | Mask literals in span attributes and the error message |

## Your data

Scan paths, predicates, join keys and group-by keys go into span attributes
as written, literals included. Metrics never carry them: every metric
dimension comes from a bounded set. See [Data and privacy](../privacy.md).

## Cost

About 0.1 ms per query for the span. Each node then adds about 9 µs per metric
instrument it reports, which is most of the cost on a large plan: about 2.8 ms
for a 22-node TPC-H query. `node_metrics=False` removes it, along with
everything derived from the counters. This runs on the
thread that ran the query, after it finished.

## When it fails

Without an OpenTelemetry SDK, the API's providers do nothing: no error, and
nothing is sent. A collector that is down is the SDK's to handle; its batch
processor drops and logs. An error inside this exporter is logged once, and
after five it is disabled for the rest of the process.
