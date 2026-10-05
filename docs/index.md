# polars-telemetry

Telemetry for [Polars](https://pola.rs) queries: a span per query with its
plan and per-node metrics for OpenTelemetry, or profiles you open in a
browser-based viewer.

!!! warning "Unaffiliated with Polars and Polars Cloud"
    This package attaches to an interface polars exposes for its own cloud
    product. That interface is internal and carries no deprecation guarantee,
    so it can change or disappear in any polars release. See
    [Compatibility](internals/compatibility.md) for what happens when it does.

!!! note
    This site tracks `main`, so it can describe work that is not released
    yet. The [changelog](https://github.com/jan-krueger/polars-telemetry/blob/main/CHANGELOG.md)
    says what shipped.

```bash
pip install 'polars-telemetry[otlp]'
```

```python
import polars_telemetry

polars_telemetry.install()
```

![Both plans of a TPC-H query, its figures, and a finding on the selected node](assets/viewer.png)

## What you get

For every query polars runs:

- how long it took, how much CPU it used, and how well it spread across cores
- both plans: scans and their pushed-down filters, joins, group-by keys
- every node's counters: rows, morsels, polls, IO time and bytes
- the most expensive node, and diagnostics such as parallel efficiency and join
  fan-out
- the file, line and function that ran it, and your own [label](labels.md)

## Where to start

| You want to… | Read |
| --- | --- |
| Try it in two minutes | [Getting started](getting-started.md) |
| Choose where queries go | [Exporters](exporters/index.md) |
| See inside one slow query | [JSONL](exporters/jsonl.md) and the [viewer](profile-viewer.md) |
| Monitor queries in production | [OpenTelemetry](exporters/opentelemetry.md) |
| Know what leaves your process | [Data and privacy](privacy.md) |
| Look up an attribute | [Spans and metrics](reference/spans-and-metrics.md) |
