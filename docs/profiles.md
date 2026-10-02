# Profiles

A profile is one self-contained JSON document describing a single query: both
plans with every node property, all 19 counters per node, the derived
diagnostics, and the fingerprint that identifies the query *shape*.

```python
from polars_telemetry.export.file import FileExporter

exporter = FileExporter("profiles/session.jsonl")
polars_telemetry.install(exporter=exporter)
```

## The session file

One JSON object per line, appended as queries complete. A session rather than a
file per query, because comparing runs is the point — the viewer groups runs by
fingerprint so "the same query, before and after" is a two-click comparison.

Each line stands alone, so a truncated file still parses up to the cut.

| Option | Default | Effect |
| --- | --- | --- |
| `max_bytes` | 64 MiB | Rotate to `<name>.1` past this size |
| `redact_literals` | `False` | Mask literal values in plan expressions |

The size bound holds **between** records, never within one: a profile is never
split or dropped, so the active file can exceed `max_bytes` by up to one
record. Profiles run around 10 KB on a plan of a dozen nodes.

A write failure is logged once and never reaches your query.

## What is in a profile

```json
{
  "schema": "polars-telemetry/profile@1",
  "polars_version": "1.44.2",
  "polars_telemetry_version": "0.1.0",
  "query_id": "...", "fingerprint": "e0933ac0fac3",
  "wall_ms": 100.7, "cpu_ms": 284.0, "result_rows": 8,
  "trace_id": "...", "span_id": "...",
  "diagnostics": { "parallel_efficiency": 0.24, "morsel_skew": 1.96, ... },
  "plan": { "physical": [ ... ], "logical": [ ... ] }
}
```

Two version numbers, because there are two sources of change: this schema, and
polars' own counter set. A file written today must still open after polars adds
a twentieth counter.

`trace_id` and `span_id` are present when a span was active, so a profile can be
linked back to the trace for the same query.

## The viewer

[Open the viewer](viewer/index.html). It starts empty. Drag one or more
`.jsonl` files onto the page, or use **Open .jsonl**.

**Nothing is uploaded.** The page does no network I/O; files are read in the
browser. That is why profiles keep plan literals at full fidelity by default
while the span-side export offers redaction — a profile never leaves the
machine unless you send it.

### Sessions are kept

Each imported file becomes a session, stored in the browser with IndexedDB, so
it survives a reload. The rail lists every session with its size and import
date; `×` removes one and **Clear all** removes the lot. Nothing is written
anywhere else.

Where storage is unavailable — a private window, blocked site data, or the page
opened straight off disk with `file://` — the viewer keeps working for the
current page only and says so, rather than pretending the data was kept.

### What it shows

- **Session overview**: query shapes ranked by total wall time, so the first
  thing you see is which shape costs most.
- **Query detail**: tiles, the diagnostics, and both plans as a DAG with CPU
  share as fill and row counts on the edges.
- **Node details**: every counter for the selected node, with polars' own
  completion flag.
- **Compare**: when a shape ran more than once, pick another run and the tiles
  and every counter gain a percentage delta.

Because a profile is one small file, it travels: attach it to a bug report,
commit it next to a regression test, or send it to someone who can read the
plan without needing access to your telemetry backend.
