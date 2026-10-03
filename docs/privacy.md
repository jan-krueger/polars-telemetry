# Data and privacy

polars-telemetry records your queries as written, literals included, because
knowing which filter was slow is usually the point. This page lists where that
content ends up and how to limit it.

## What can carry your data

| Data | Example | OpenTelemetry | JSONL | Console |
| --- | --- | --- | --- | --- |
| Literals in predicates | `col("email") == "someone@example.com"` | span attributes | plans | — |
| Scan paths | `s3://bucket/customers.parquet` | span attributes | plans | — |
| Column names and keys | `col("customer_id")` | span attributes | plans | — |
| Source paths | `/srv/app/reports.py` | `code.*` attributes | `call_site` | file name |
| Labels | `nightly/revenue_by_region` | span attribute | `label` | header |
| Error messages | polars' message, which can quote values | span status | `failed` | header |

Metrics carry none of this. Every metric dimension comes from a bounded set:
node kinds, engine, direction and the plan fingerprint, which is a hash of the
plan's shape without literals. The span attributes that can carry query content
are listed in
[Spans and metrics](reference/spans-and-metrics.md#attributes-that-can-carry-your-data).

## Limiting it

`Config(redaction=...)` masks a query before any exporter receives it,
including one you wrote. `Redaction()` masks literal values; each kind can be
switched on or off:

```python
import polars_telemetry
from polars_telemetry import Config, Redaction

polars_telemetry.install(Config(redaction=Redaction()))
```

| Field | Default | Masks | Becomes |
| --- | --- | --- | --- |
| `strings` | on | quoted text, except column and alias names | `"<str>"` |
| `numbers` | on | numbers, including `1.0000e-9` | `<num>` |
| `temporal` | on | dates, datetimes, times, durations | `<date>`, `<datetime>`, `<time>`, `<duration>` |
| `paths` | off | files scanned or written | `<path>` |
| `call_site` | off | the file, line and function that ran the query | dropped |
| `labels` | off | labels set with `label()` | dropped |
| `custom` | none | your own rule, applied to every expression and error message after the others | whatever it returns |

Masking keeps the structure and column names, so you can still see which
filter was slow:

```text
col("email") == "someone@example.com"   ->   col("email") == "<str>"
col("amount") > 60.0                    ->   col("amount") > <num>
col("placed") >= 2024-01-01             ->   col("placed") >= <date>
```

It works on polars' text form of expressions, so treat it as a precaution, not
a compliance guarantee. `include_plan` stays off by default, and keeps the
whole plan off spans. A masked profile says so in its `redacted` field, and the
viewer shows it next to the query.

## One setting per exporter

Wrap an exporter in `redacted()` to give it its own setting in place of the
config's. A shared backend can get a masked copy while a file on the same
machine keeps everything:

```python
import polars_telemetry
from polars_telemetry import Config, Redaction, redacted
from polars_telemetry.export.file import FileExporter
from polars_telemetry.export.otel import OTelExporter

config = Config(redaction=Redaction())
polars_telemetry.install(
    config,
    exporter=[
        redacted(OTelExporter(config), Redaction(paths=True, call_site=True)),
        redacted(FileExporter("profiles/full.jsonl"), None),  # everything
    ],
)
```

Exporters left unwrapped follow `config.redaction`.

## Where it goes

- **OpenTelemetry**: wherever your SDK sends spans. Your tracing backend's
  access rules apply.
- **JSONL**: a file on the machine that ran the query. The viewer reads it in
  the browser and uploads nothing.
- **Console**: your terminal or wherever standard error is collected.
- **Viewer links**: a [shared link](profile-viewer.md#sharing-a-query) holds the
  profiles themselves, readable by anyone it reaches.
