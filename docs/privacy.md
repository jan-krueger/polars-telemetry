# Data and privacy

polars-telemetry records your queries as written, literals included. This page
lists where that content ends up and how to limit it.

## What can carry your data

| Data | Example | OpenTelemetry | DogStatsD | JSONL | Console |
| --- | --- | --- | --- | --- | --- |
| Literals in predicates | `col("email") == "someone@example.com"` | span attributes | — | plans | — |
| Scan paths | `s3://bucket/customers.parquet` | span attributes | — | plans | — |
| Column names and keys | `col("customer_id")` | span attributes | — | plans | — |
| Source paths | `/srv/app/reports.py` | `code.*` attributes | — | `call_site` | file name |
| Labels | `nightly/revenue_by_region` | span attribute | `label` tag, with `tag_labels=True` | `label` | header |
| Error messages | Polars' message, which can quote values | span status | — | `failed` | header |
| Findings | `Deduplication removes no rows` | span events | — | `insights` | warnings |

Findings hold numbers, Polars' node kinds and API names, never a column name or
a literal. Metrics carry none of this table, except the DogStatsD `label` tag:
every metric dimension comes from a bounded set (`semconv.METRIC_DIMENSIONS`).
The span attributes that can carry query content are listed in
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
| `paths` | off | files scanned or written, and a plugin's library path in an expression | `<path>` |
| `call_site` | off | the file, line and function that ran the query | dropped |
| `labels` | off | labels set with `label()` | dropped |
| `custom` | none | your own rule, applied to every expression and error message after the others | whatever it returns |
| `url_queries` | on, **even without a redaction** | a URL's query string, in paths, expressions and error messages | `?<query>` |

Masking keeps the structure and column names:

```text
col("email") == "someone@example.com"   ->   col("email") == "<str>"
col("amount") > 60.0                    ->   col("amount") > <num>
col("placed") >= 2024-01-01             ->   col("placed") >= <date>
```

Masking works on Polars' text form of expressions: a precaution, not a
compliance guarantee. Polars writes text values without escaping them, so a
value containing `"` can make an expression ambiguous; then everything from
its first text value on is masked. `include_plan`, off by default, keeps the
whole plan off spans. A masked profile says so in its `redacted` field, and
the viewer shows it next to the query.

### URL query strings

A presigned S3 URL, a signed GCS URL or an Azure SAS URL carries its credential
in the query string, and Polars keeps the whole URL in the plan. Every exporter
masks the query string, with or without a redaction:
`https://bucket.s3.amazonaws.com/data/orders.parquet?<query>`. The bucket and
path stay. `s3://` paths and credentials passed as `storage_options` are never
in the plan. To keep query strings:

```python
Redaction(strings=False, numbers=False, temporal=False, url_queries=False)
```

A profile's `redacted` field does not list it; it records only what you chose
to mask.

## One setting per exporter

`redacted()` gives an exporter its own setting in place of the config's, such as
a masked copy for a shared backend and everything in a local file:

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
        redacted(FileExporter("profiles/full.jsonl"), None),  # all but URL query strings
    ],
)
```

Exporters left unwrapped follow `config.redaction`. One exporter keeps URL query
strings only with `redacted(exporter, Redaction(strings=False, numbers=False,
temporal=False, url_queries=False))`.

## Where it goes

| Output | Destination |
| --- | --- |
| OpenTelemetry | wherever your SDK sends spans; your tracing backend's access rules apply |
| DogStatsD | wherever your DogStatsD client sends, usually the Datadog Agent or Telegraf |
| JSONL | a file on the machine that ran the query; the [viewer](profile-viewer.md) reads it in the browser and uploads nothing |
| Console | your terminal or wherever standard error is collected |
| Viewer links | a [shared link](profile-viewer.md#sharing-a-query) holds the profiles themselves, readable by anyone it reaches |
