# polars-telemetry

See what your Polars queries do: timings and row counts for every node of every
query, both plans in a browser viewer, and findings on what slows a query down.
Send the same data to OpenTelemetry or DogStatsD when you want it in your
observability stack.

```bash
pip install polars-telemetry
```

![Both plans of a TPC-H query, its figures, and a finding on the selected node](assets/viewer.png)

!!! warning "Unaffiliated with Polars and Polars Cloud"
    It uses an interface Polars exposes for Polars Cloud, which can change in
    any Polars release. See [Compatibility](internals/compatibility.md).

!!! note
    This site tracks `main` and can describe unreleased work. The
    [changelog](https://github.com/jan-krueger/polars-telemetry/blob/main/CHANGELOG.md)
    says what shipped.

## Where to start

| You want to… | Read |
| --- | --- |
| Profile a query in two minutes | [Getting started](getting-started.md) |
| Look inside a plan | [Profile viewer](profile-viewer.md) |
| Find what slows a query | [Insights](insights.md) |
| Name queries and profile a block of code | [Labels](labels.md) |
| Send queries to your observability stack | [Exporters](exporters/index.md) |
| Know what leaves your process | [Data and privacy](privacy.md) |
| Look up an attribute or metric | [Spans and metrics](reference/spans-and-metrics.md) |
| Fix something that is missing | [Troubleshooting](troubleshooting.md) |
| Run alongside Polars Cloud | [Polars Cloud](polars-cloud.md) |
