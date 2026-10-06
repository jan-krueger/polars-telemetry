# DogStatsD

Per-query and per-node metrics with tags, sent through Datadog's DogStatsD
client to the Datadog Agent, or to Telegraf on its way to InfluxDB.

## Use it when

- You report to Datadog through its Agent, or run Telegraf, and do not use
  OpenTelemetry.
- You want the metrics without spans, at about a third of the OpenTelemetry
  exporter's cost.

## Set up

```bash
pip install 'polars-telemetry[datadog]'
```

```python
from datadog import DogStatsd

import polars_telemetry
from polars_telemetry.export.dogstatsd import DogStatsdExporter

statsd = DogStatsd(
    host="localhost",
    port=8125,
    disable_buffering=False,  # many values per packet
    disable_background_sender=False,  # send off the query's thread
)
polars_telemetry.install(exporter=DogStatsdExporter(statsd))
```

The client's configuration decides where the metrics go: the host, a Unix
socket, a `namespace` prefix, `constant_tags`, the `DD_ENV`, `DD_SERVICE` and
`DD_VERSION` variables. With no client, the exporter uses `datadog.statsd`,
which `datadog.initialize()` configures.

!!! warning "Turn buffering on"
    With the client's defaults every value is its own packet, which costs
    about eight times as much: 8 ms instead of 1 ms for a 22-node query.

### Into InfluxDB through Telegraf

Telegraf's `statsd` input reads the tags as line-protocol tags. Send
histograms: Telegraf summarises them per flush, but keeps only one sample of a
distribution.

```python
DogStatsdExporter(statsd, distributions=False)
```

```toml
[[inputs.statsd]]
  protocol = "udp"
  service_address = ":8125"
  datadog_extensions = true
  percentiles = [50.0, 90.0, 99.0]
  metric_separator = "_"
  delete_counters = true
  delete_timings = true
```

Each metric becomes a measurement, such as `polars_query_duration`, with
`count`, `mean`, `median`, `upper`, `lower`, `sum`, `stddev` and the percentiles
as fields.

## What you get

The same metrics as the [OpenTelemetry exporter](opentelemetry.md), under the
same names: times and ratios as distributions (or histograms), totals as counts.

```text
polars.query.duration:131.2|d|#engine:streaming,fingerprint:f7d144838d88
polars.node.cpu_time:81.1|d|#node_kind:GroupBy,engine:streaming
polars.node.rows_out:2696064|c|#node_kind:GroupBy,engine:streaming
```

| Tag | On | Values |
| --- | --- | --- |
| `engine` | every metric except `polars.query.insights` | `streaming`, `in-memory`, `unknown` |
| `fingerprint` | query metrics | one per query shape |
| `node_kind` | node metrics | Polars' node kinds, such as `GroupBy` |
| `direction` | `io_bytes`, `largest_morsel` | `requested`, `received`, `sent` |
| `rule`, `level` | `polars.query.insights` | an [insight rule](../insights.md) id; `warn` or `info` |
| `label` | every metric, if `tag_labels=True` | your [labels](../labels.md) |

No spans: StatsD carries metrics only. For traces, use the OpenTelemetry
exporter; the Datadog Agent accepts OTLP too.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `client` | `datadog.statsd` | The `DogStatsd` to send through |
| `metric_names` | the names in [Spans and metrics](../reference/spans-and-metrics.md#metrics) | Rename metrics, by a mapping or a function; a name mapped to `None` is not sent; an unknown name raises `ValueError` |
| `tag_names` | the keys in the table above | Rename tag keys; a key mapped to `None` is not sent; an unknown key raises `ValueError` |
| `tag_labels` | `False` | Tag every metric with the query's label |
| `distributions` | `True` | Times and ratios as distributions (`|d`); `False` sends histograms (`|h`) |

```python
DogStatsdExporter(
    statsd,
    metric_names={"polars.query.duration": "polars_query_ms"},
    tag_names={"node_kind": "kind", "fingerprint": None},
)
```

## Your data

None: metrics never carry literals, paths or call sites. Labels are only sent
with `tag_labels=True`.

Datadog bills each distinct metric and tag combination as a custom metric.
Node metrics are bounded by Polars' node kinds. Query metrics grow with the
number of query shapes, through `fingerprint`; if that is large, drop it with
`tag_names={"fingerprint": None}`. Turn on `tag_labels` only for labels from a
small, fixed set.

## Cost

About 0.1 ms per query on a small plan and 1 ms on a 22-node one, with
buffering and the background sender on. Values are queued on the query's thread
and sent from the client's.

## When it fails

Over UDP, nothing fails: with no Agent listening, packets are lost silently.
An error from the client is handled as for
[every exporter](index.md#failures-stay-contained). The client holds up to
0.3 s of values; `uninstall()` and the process's exit send them.
