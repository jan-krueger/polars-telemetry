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

To collect only a block of code instead of the whole process, use
[`profile()`](../labels.md#scope-a-block-of-code) and `session.write(path)`,
which writes the same format.

## What you get

One JSON object per line, appended as each query finishes. A file cut off
mid-write still reads up to the last complete line.

```json
{
  "schema": "polars-telemetry/profile@1",
  "polars_version": "1.44.2", "polars_telemetry_version": "0.2.0",
  "query_id": "01a10139-b376-79e1-a019-fdd89782ff8f",
  "label": "nightly/revenue_by_region",
  "fingerprint": "f7d144838d88",
  "started_unix_ns": 1791021921142995890,
  "wall_ms": 20.49, "cpu_ms": 81.71, "result_rows": 4,
  "call_site": { "filepath": "/srv/app/reports.py", "lineno": 23,
                 "function": "revenue_by_region" },
  "failed": null,
  "trace_id": "...", "span_id": "...",
  "diagnostics": { "parallel_efficiency": 0.33, "morsel_skew": 1.46, ... },
  "plan": { "physical": [ ... ], "logical": [ ... ] }
}
```

| Field | What it is |
| --- | --- |
| `schema` | The format and its version; readers check it |
| `polars_version`, `polars_telemetry_version` | What produced it; polars' counters change independently of the format |
| `label` | From [`label()`](../labels.md), else `null` |
| `fingerprint` | The plan's shape, without literals: equal for runs of the same query |
| `call_site` | The file, line and function that ran the query, else `null` |
| `trace_id`, `span_id` | Present when a span was active, linking the profile to its trace |
| `diagnostics` | Derived figures, as on the [span](../reference/spans-and-metrics.md#diagnostics) |
| `plan.physical` | Physical nodes with their properties, `role`, and all 19 counters |
| `plan.logical` | The logical plan's nodes, with your own column names |

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `path` | required | The file; its directory is created |
| `max_bytes` | 64 MiB | Past this, the file moves to `<name>.1` and a new one starts |
| `redact_literals` | `False` | Mask literals in the plans written |

At most about twice `max_bytes` is on disk: the current file and one previous.

## Your data

Everything the plans contain, literals included, which is what makes a
profile useful. The file stays where it is written; the viewer reads it in the
browser and uploads nothing. See [Data and privacy](../privacy.md).

## Cost

About 0.1 ms per query on a small plan and 0.35 ms on a 22-node one, on the
thread that ran the query. A profile is 2–25 KB.

## When it fails

A profile that cannot be built or written is skipped. The first such error is
logged; the exporter keeps trying on the next query, so a full disk or a
missing permission recovers once fixed.
