# Exporters

An exporter receives every finished query and sends it somewhere. Four ship
with the package; [writing your own](custom.md) takes one method.

| | [OpenTelemetry](opentelemetry.md) | [DogStatsD](dogstatsd.md) | [JSONL](jsonl.md) | [Console](console.md) |
| --- | --- | --- | --- | --- |
| Sends to | your OpenTelemetry SDK | the Datadog Agent or Telegraf | a `.jsonl` file | standard error |
| Use it when | monitoring in production | monitoring with Datadog or InfluxDB | investigating a plan, the viewer | debugging locally |
| Per query | a span, plus per-node metrics | per-node metrics with tags | both plans and every counter | a dozen lines of text |
| Your data | in span attributes | none | in the file, which stays local | on your terminal |
| Cost | ~0.1–2.4 ms, ~9 µs per value | ~0.1–1 ms, buffered | ~0.1–0.4 ms, 2–25 KB | negligible |
| When it fails | disabled after 5 errors | lost silently over UDP | first error logged, keeps trying | disabled after 5 errors |

With no `exporter` argument, `install()` uses OpenTelemetry.

## Several at once

`exporter` takes a list. Each exporter receives every query:

```python
import polars_telemetry
from polars_telemetry import Config
from polars_telemetry.export.file import FileExporter
from polars_telemetry.export.otel import OTelExporter

config = Config()
polars_telemetry.install(
    config,
    exporter=[OTelExporter(config), FileExporter("profiles/session.jsonl")],
)
```

## Failures stay contained

Exporters run on the thread that ran the query, after it has finished. An
exporter that raises never fails the query: the error is logged once, and after
five errors that exporter stops receiving queries while the others carry on.

```text
polars-telemetry: disabling exporter ConsoleExporter after 5 errors. Queries are unaffected.
```
