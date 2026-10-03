# Getting started

## Install

```bash
pip install polars-telemetry          # the OpenTelemetry API only
pip install 'polars-telemetry[otlp]'  # with the SDK and OTLP exporter
```

Requires Python 3.10+ and polars 1.44.1 or a newer 1.44.x; see
[Compatibility](internals/compatibility.md).

## See your first query

The console exporter needs no other setup, so it is the quickest way to check
that everything works:

```python
import polars as pl
import polars_telemetry
from polars_telemetry.export.console import ConsoleExporter

polars_telemetry.install(exporter=ConsoleExporter())

pl.LazyFrame({"region": ["EU", "US", "EU"], "amount": [10, 20, 30]}).group_by("region").agg(
    pl.col("amount").sum()
).collect()
```

```text
polars query 01a1013c ok wall=2.63ms cpu=2.33ms parallelism=0.89x nodes=5 rows_out=2
  at example.py:9 in <module>()
  GroupBy               1.78ms  in=           3  out=           2
  InMemorySource        0.39ms  in=           0  out=           3
  InMemorySink            82us  in=           2  out=           0
  SimpleProjection        48us  in=           3  out=           3
  SimpleProjection        25us  in=           2  out=           2
```

!!! note "Activation is always explicit"
    `install()` enables polars' query monitoring, which sets the engine
    affinity to `"streaming"` and so changes how your queries execute. It never
    happens on import, and `uninstall()` cannot restore the previous affinity.

`install()` returns what was installed, or `None` when this polars cannot be
instrumented:

```python
state = polars_telemetry.install()
if state is None:
    ...  # see the logged warning
else:
    print(state.capabilities.polars_version, state.capabilities.node_metrics_usable)
```

## Where next

- Pick where queries go: [Exporters](exporters/index.md) compares
  OpenTelemetry, JSONL files and the console.
- Name what runs and collect one block of code:
  [Label and scope queries](labels.md).
- Look inside a plan: [Profile viewer](profile-viewer.md).
- Change what is recorded: [Configuration](reference/configuration.md).
