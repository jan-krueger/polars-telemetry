# Exporters

An exporter receives every finished query and sends it somewhere. Six ship
with the package; [writing your own](custom.md) takes one method.

| | [OpenTelemetry](opentelemetry.md) | [DogStatsD](dogstatsd.md) | [JSONL](jsonl.md) | [Events](events.md) | [Events over HTTP](http-events.md) | [Console](console.md) |
| --- | --- | --- | --- | --- | --- | --- |
| Sends to | your OpenTelemetry SDK | the Datadog Agent or Telegraf | a `.jsonl` file | a `.jsonl.gz` file | a server, over HTTP | standard error |
| Needs | `polars-telemetry[otlp]` and an SDK set up | `polars-telemetry[datadog]` | nothing more | nothing more | a server that receives events | nothing more |
| Use it when | monitoring in production | monitoring with Datadog or InfluxDB | the viewer and `polars-telemetry insights` | recording how queries progress | following queries from many processes | debugging locally |
| Per query | a span, plus per-node metrics | per-node metrics with tags | both plans and every counter | the same, plus a sample every second while it runs | the same as Events | a few lines of text |
| Your data | span attributes and status | none, or labels with `tag_labels` | in the file, which stays local | in the file, which stays local | sent to the server | on your terminal |
| Cost | ~0.1–2.4 ms, ~9 µs per value | ~0.1–1 ms, buffered | ~0.1–0.4 ms, 2–25 KB | ~15 ms per sample of 500 nodes, in the background | the same, sent in the background | negligible |
| When it fails | disabled after 5 errors | lost silently over UDP | first error logged, keeps trying | first error logged, keeps trying | first error logged, retries; stops on a refused token | disabled after 5 errors |

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
