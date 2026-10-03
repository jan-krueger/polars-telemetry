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

| To keep out | Set |
| --- | --- |
| Literal values, in plans and error messages | `Config(redact_literals=True)` |
| Source file paths | `Config(call_site=False)` |
| The whole plan on spans | leave `Config(include_plan=False)`, the default |

With `redact_literals`, values are masked and the structure and column names
kept:

```text
col("email") == "someone@example.com"   ->   col("email") == "<str>"
col("amount") > 60.0                    ->   col("amount") > <num>
```

The setting applies before any exporter receives a query, including one you
wrote. Masking works on polars' text form of expressions, so treat it as a
precaution, not a compliance guarantee.

## Where it goes

- **OpenTelemetry**: wherever your SDK sends spans. Your tracing backend's
  access rules apply.
- **JSONL**: a file on the machine that ran the query. The viewer reads it in
  the browser and uploads nothing.
- **Console**: your terminal or wherever standard error is collected.
