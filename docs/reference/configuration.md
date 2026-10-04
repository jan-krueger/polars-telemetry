# Configuration

`Config` decides what is recorded about each query. Pass it to `install()`, and
to `OTelExporter` when you create one yourself:

```python
import polars_telemetry
from polars_telemetry import Config, Redaction

polars_telemetry.install(Config(include_plan=True, redaction=Redaction()))
```

| Option | Default | Effect | Cost |
| --- | --- | --- | --- |
| `node_metrics` | `True` | Read each node's counters when the query ends: per-node metrics, `polars.cpu_ms`, the hot node, most diagnostics, and the counters in profiles | Most of the OpenTelemetry exporter's time on large plans |
| `include_plan` | `False` | Put the whole plan and its counters on the span as JSON in `polars.plan` | Kilobytes per span |
| `call_site` | `True` | Record the file, line and function that ran the query | Under a microsecond |
| `describe_fallbacks` | `True` | Have polars describe what an in-memory fallback node runs, by setting `POLARS_STREAM_ALWAYS_PREPARE_VISUALIZATION_DATA=1` at `install()` when it is unset. polars reads it for the rest of the process | A fraction of a millisecond per query |
| `redaction` | `None` | What to mask before any exporter receives a query; see [Data and privacy](../privacy.md) | Small, once per query and setting |

Exporter options, such as a file's size limit, are on each
[exporter's page](../exporters/index.md).
