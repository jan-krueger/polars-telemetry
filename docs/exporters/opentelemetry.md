# OpenTelemetry

One span per query and per-node metrics, sent wherever your OpenTelemetry SDK
sends them.

## Use it when

- You run polars in a service or pipeline that already reports to
  OpenTelemetry, and want queries in the same traces.
- You want dashboards and alerts on query time across many runs.

## Set up

The package depends on the OpenTelemetry API only. Your application installs
the SDK and decides where data goes; the `otlp` extra adds the SDK and the OTLP
exporter.

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
query ran. For a filtered parquet scan, deduplicated and grouped:

```text
polars.collect
  polars.query.label             orders_by_region
  polars.engine                  streaming
  polars.plan.fingerprint        2e35f01c764d
  code.file.path                 /srv/app/reports.py
  code.line.number               15
  polars.planning_ms             0.594
  polars.cpu_ms                  29.352
  polars.parallelism             1.512
  polars.result.rows             2
  polars.insights.warnings       1
  polars.hot_node.kind           GroupBy
  polars.hot_node.share          0.7616
  polars.scan.sources            ("/srv/app/data/orders.parquet",)
  polars.scan.predicates         ('col("amount") > 100',)
  polars.scan.predicate_pushed   True
  polars.groupby.keys            ('col("region")',)
  ...
  event polars.insight
    polars.insight.rule          redundant_aggregation
    polars.insight.title         Deduplication removes no rows
    polars.insight.evidence      rows_in 200K · rows_removed 0
    polars.insight.fix           drop the `unique`/`group_by` if keys are unique by construction, or dedup at the source
```

Each [finding](../insights.md) is a `polars.insight` event on the span. A
failed query sets status `ERROR` with polars' message. No child spans per node:
polars reports no per-node timestamps.

Metrics: query timings by plan fingerprint and engine, node counters by node
kind, and finding counts by rule. Every name, unit and dimension:
[Spans and metrics](../reference/spans-and-metrics.md#metrics).

## Options

Set on `install()`'s `Config`:

| Option | Default | Effect here |
| --- | --- | --- |
| `node_metrics` | `True` | Per-node counters and all that comes from them: node metrics, `polars.cpu_ms`, the hot node, most diagnostics |
| `include_plan` | `False` | The whole plan as JSON in `polars.plan` |
| `call_site` | `True` | The `code.*` attributes |
| `insights` | `True` | The `polars.insight` events, `polars.insights.warnings` and the `polars.query.insights` counter |
| `redaction` | `None` | Mask literals and more in span attributes and the error message |

An `OTelExporter(config)` you build yourself reads only `include_plan` from its
own `config`, and `redaction` when `install()`'s has none; the other options
come from `install()`'s. To mask for this exporter alone, wrap it in
`redacted()`; see [Data and privacy](../privacy.md#one-setting-per-exporter).

## Your data

Query content goes into span attributes and the error status; metrics never
carry it. See [Data and privacy](../privacy.md#what-can-carry-your-data).

## Cost

About 0.1 ms per query for the span. Metrics cost about 9 µs per value
recorded: one per node for each time and ratio, one per node kind for each
count (counts are summed first). On a large plan they dominate: about 2.4 ms
for a 22-node TPC-H query. `node_metrics=False` removes it, with everything
derived from the counters. All of it runs on the query's thread, after the
query finishes.

## When it fails

Without an OpenTelemetry SDK, the API's providers do nothing: no error,
nothing sent. A collector that is down is the SDK's to handle; its batch
processor drops and logs. An error inside this exporter is handled as for
[every exporter](index.md#failures-stay-contained).
