# Shipping to InfluxDB

The package speaks OTLP, so it does not care what receives it. A collector is
one option; **Telegraf** is another, and it writes straight to InfluxDB with no
OpenTelemetry Collector in the path.

```
your app ──OTLP/gRPC──▶ Telegraf ──line protocol──▶ InfluxDB ──▶ Grafana
```

Bring it up alongside the default stack:

```bash
docker compose -f docker/compose.yaml -f docker/compose.influx.yaml up -d --wait
```

Point the application at Telegraf instead of the collector — in the bundled
stack that is port **4327**, because 4317 is already taken by the collector.

## What arrives

**Metrics** land as first-class fields on a `prometheus` measurement, with
every dimension preserved as a tag:

```
tags:   polars.plan.fingerprint, polars.node.kind, polars.direction,
        polars.engine, service.name, le
fields: polars.node.cpu_time_{sum,count,min,max,bucket}
        polars.node.rows_in, polars.node.rows_out, polars.node.polls, ...
```

Histogram buckets survive, so quantiles still work. A query by plan node:

```flux
from(bucket:"telemetry") |> range(start:-30m)
  |> filter(fn:(r) => r._measurement == "prometheus"
                   and r._field == "polars.node.cpu_time_sum")
  |> group(columns:["polars.node.kind"]) |> sum()
```

**Spans** land on a `spans` measurement. By default Telegraf keeps only a few
attributes as tags and bundles the rest into an `attributes` field as JSON —
all 28 attributes are there, but they are not individually queryable.

## Promoting span attributes — carefully

`span_dimensions` turns a span attribute into a line-protocol tag. In InfluxDB
a tag is **part of the series key**, so only bounded attributes belong there:

```toml
span_dimensions = [
  "service.name",
  "span.name",
  "polars.plan.fingerprint",
  "polars.engine",
  "polars.hot_node.kind",
]
```

!!! danger "Never promote these"
    `polars.query_id` is unique per query — promoting it creates one series per
    query and will take the database down. The same applies to
    `polars.scan.sources`, `polars.scan.predicates`, `polars.join.keys` and
    `polars.groupby.keys`, which carry literals.

    This is exactly why `polars.plan.fingerprint` exists: it identifies the
    query *shape*, is bounded by your code paths, and is safe as a tag.

With those promoted, spans become directly queryable:

```flux
from(bucket:"telemetry") |> range(start:-30m)
  |> filter(fn:(r) => r._measurement == "spans" and r._field == "duration_nano")
  |> group(columns:["polars.plan.fingerprint","polars.hot_node.kind"])
  |> mean()
```

## Grafana

Add InfluxDB as a datasource with the Flux query language and point the panels
at the queries above. The metric side needs no translation — the dimensions are
the same ones the Prometheus path uses, so a dashboard built against one ports
to the other by swapping the query language.
