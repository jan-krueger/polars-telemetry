# Profiles

A profile is one self-contained JSON document describing a single query: both
plans with every node property, all 19 counters per node, the derived
diagnostics, and a fingerprint identifying the query *shape*.

```python
from polars_telemetry.export.file import FileExporter

polars_telemetry.install(exporter=FileExporter("profiles/session.jsonl"))
```

## The session file

One JSON object per line, appended as queries complete, so a truncated file
still parses up to the cut. Profiles run around 10 KB on a plan of a dozen
nodes.

| Option | Default | Effect |
| --- | --- | --- |
| `max_bytes` | 64 MiB | Rotate to `<name>.1` past this size |
| `redact_literals` | `False` | Mask literal values in plan expressions |

The size bound holds *between* records, never within one: a profile is never
split or dropped, so the active file can exceed `max_bytes` by up to one
record. A write failure is logged once and never reaches your query.

## What is in a profile

```json
{
  "schema": "polars-telemetry/profile@1",
  "polars_version": "1.44.2", "polars_telemetry_version": "...",
  "query_id": "...", "fingerprint": "e0933ac0fac3",
  "started_unix_ns": 1759478400000000000,
  "wall_ms": 100.7, "cpu_ms": 284.0, "result_rows": 8,
  "call_site": { "filepath": "/srv/app/pipeline.py", "lineno": 142,
                 "function": "build_report" },
  "failed": null,
  "trace_id": "...", "span_id": "...",
  "diagnostics": { "parallel_efficiency": 0.24, "morsel_skew": 1.96, ... },
  "plan": { "physical": [ ... ], "logical": [ ... ] }
}
```

Both version numbers are recorded, because the schema and polars' own counter
set change independently.

`trace_id` and `span_id` are present when a span was active, linking a profile
back to the trace for the same query.

## The viewer

[Open the viewer](viewer/index.html). It starts empty: drag one or more
`.jsonl` files onto the page, or use **Open .jsonl**. The repository's
[`examples/`](https://github.com/jan-krueger/polars-telemetry/tree/main/examples)
holds TPC-H sessions to try it with: the 22 queries at scale factor 1 and 10,
three runs each, labelled `tpch/q1` to `tpch/q22`.

**Nothing is uploaded.** The page does no network I/O; files are read in the
browser.

![Both plans, per-node counters and diagnostics for one query](assets/viewer.png)

### Sessions

Each imported file becomes a session stored in the browser with IndexedDB, so
it survives a reload. The rail lists every session with its size and import
date; `×` removes one and **Clear all** removes the lot.

Where storage is unavailable — a private window, blocked site data, or the page
opened from disk with `file://` — the viewer keeps working for the current page
only and says so.

### Reading a plan

Both panes are [React Flow](https://reactflow.dev) canvases: drag to pan,
scroll or pinch to zoom, and the minimap shows where you are in a plan too
large to fit. Nodes are laid out with dagre, sources at the bottom and the sink
at the top.

A 90-node plan is not legible at fit-to-pane zoom: zoom in, or click a node and
read it in the rail.

### What it shows

- **Session overview**: query shapes ranked by total wall time.
- **Query detail**: tiles, diagnostics, and both plans side by side. The
  logical plan is an outline and carries your own column names; the physical
  plan is filled by share of CPU, with row counts on the edges and a completion
  dot per node, but renames columns to `_POLARS_TMP_N`.

    polars gives the two plans separate node identities and no mapping between
    them, so selecting a node in one does not highlight its counterpart in the
    other.
- **Node details**: the node's properties as typed fields, then every counter
  for the selected node. Each carries a `?` explaining what it measures.
- **Compare**: when a shape ran more than once, pick another run and the tiles
  and every counter gain a percentage delta.
