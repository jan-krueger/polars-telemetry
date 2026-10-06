# JSONL

One profile per query, appended to a `.jsonl` file that the
[profile viewer](../profile-viewer.md) opens.

## Use it when

- You want to see why a query is slow: both plans, every counter, per node.
- You want to compare runs of the same query, before and after a change.
- Nothing should leave the machine: there is no network involved.

## Set up

```python
import polars_telemetry
from polars_telemetry.export.file import FileExporter

polars_telemetry.install(exporter=FileExporter("profiles/session.jsonl"))
```

To collect one block of code instead of the whole process, use
[`profile()`](../labels.md#scope-a-block-of-code) and `session.write(path)`;
same format.

## What you get

One JSON object per line, appended as each query finishes. A file cut off
mid-write still reads up to the last complete line.

```json
{
  "schema": "polars-telemetry/profile@1",
  "polars_version": "1.44.2", "polars_telemetry_version": "0.8.0",
  "query_id": "01a111e4-c72d-78a1-86fc-873485d15878",
  "label": "orders_by_region",
  "fingerprint": "c4833db25e35",
  "started_unix_ns": 1791301568301453578,
  "wall_ms": 8.7752, "planning_ms": 0.9702, "telemetry_ms": 0.1893,
  "cpu_ms": 34.1368, "result_rows": 2,
  "call_site": { "filepath": "/srv/app/reports.py", "lineno": 7, "function": "<module>" },
  "failed": null, "redacted": null,
  "diagnostics": { "parallel_efficiency": 0.33, "cpu_count": 12, "morsel_skew": 1.5, ... },
  "plan": { "physical": [ ... ], "logical": [ ... ] },
  "insights": { "schema": "insights@1", "findings": [ ... ] }
}
```

| Field | What it is |
| --- | --- |
| `schema` | The format and its version; readers check it |
| `polars_version`, `polars_telemetry_version` | What produced it; polars' counters change independently of the format |
| `label` | From [`label()`](../labels.md), else `null` |
| `fingerprint` | The plan's shape, without literals: equal for runs of the same query |
| `wall_ms`, `planning_ms`, `telemetry_ms`, `cpu_ms` | Wall time; of it, polars' planning and this package's own work before execution; node CPU |
| `call_site` | The file, line and function that ran the query, else `null` |
| `trace_id`, `span_id` | The trace and span that were active when the query ran (with the OpenTelemetry exporter, the parent of `polars.collect`), else absent |
| `redacted` | What was masked before writing, such as `["strings", "numbers"]`, else `null` |
| `diagnostics` | Derived figures, as on the [span](../reference/spans-and-metrics.md#diagnostics) |
| `plan.physical` | Physical nodes with `kind`, `role`, `inputs`, `properties` and `metrics`: every polars counter, `done`, and on polars 2 [custom node metrics](../reference/spans-and-metrics.md#custom-node-metrics) |
| `plan.logical` | The logical plan's nodes, with your own column names |
| `insights` | The [findings](../insights.md), when `Config(insights=True)`, the default |

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `path` | required | The file; its directory is created |
| `max_bytes` | 64 MiB | Past this, the file moves to `<name>.1` and a new one starts |

At most about twice `max_bytes` is on disk: the current file and one previous.
Masking is set on `install()`'s config, or for this file alone with
`redacted(FileExporter(...), Redaction())`.

## Your data

Everything the plans contain, literals included; URL query strings are masked.
The file stays where it is written, and the viewer uploads nothing. See
[Data and privacy](../privacy.md).

## Cost

About 0.1 ms per query on a small plan and 0.35 ms on a 22-node one, on the
thread that ran the query. A profile is 2–25 KB.

## When it fails

A profile that cannot be built or written is skipped and the first such error
logged. The exporter retries on the next query, so a full disk or a missing
permission recovers once fixed.
