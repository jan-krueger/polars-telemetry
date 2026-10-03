# Configuration

`Config` decides what is recorded about each query. Pass it to `install()`, and
to `OTelExporter` when you create one yourself:

```python
import polars_telemetry
from polars_telemetry import Config

polars_telemetry.install(Config(include_plan=True, redact_literals=True))
```

| Option | Default | Effect | Cost |
| --- | --- | --- | --- |
| `node_metrics` | `True` | Read each node's counters when the query ends: per-node metrics, `polars.cpu_ms`, the hot node, most diagnostics, and the counters in profiles | Most of the OpenTelemetry exporter's time on large plans |
| `include_plan` | `False` | Put the whole plan and its counters on the span as JSON in `polars.plan` | Kilobytes per span |
| `call_site` | `True` | Record the file, line and function that ran the query | Under a microsecond |
| `redact_literals` | `False` | Mask literal values in plans before any exporter receives them; see [Data and privacy](../privacy.md) | Small, once per query |
| `resource_attributes` | `{}` | Deprecated and never applied; set resource attributes on your OpenTelemetry provider | — |

Exporter options, such as a file's size limit, are on each
[exporter's page](../exporters/index.md).
