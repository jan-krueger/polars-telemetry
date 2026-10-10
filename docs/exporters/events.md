# Events

What happens to each query while it runs, appended to a `.jsonl` or
`.jsonl.gz` file: announced with its plan, sampled every second, and its full
profile when it finishes.

## Use it when

- You want to see how a long query progresses, not only how it ended: which
  nodes were busy when, and how rows flowed.
- You want to record a pipeline in production now and look at it later.
- Nothing should leave the machine: there is no network involved.

## Set up

```python
import polars_telemetry
from polars_telemetry.export.events import FileEventExporter

polars_telemetry.install(exporter=FileEventExporter("profiles/events.jsonl.gz"))
```

It can run next to other exporters, such as the
[OpenTelemetry](opentelemetry.md) one; pass a list.

## What you get

One event per line. Every line has `"schema": "polars-telemetry/events@1"` and a
`type`:

```json
{"type": "process", "host": "worker-3", "pid": 4711, "started_unix_ns": ..., "polars_telemetry_version": "0.9.0"}
{"type": "query.started", "query_id": "...", "label": "nightly/orders", "fingerprint": "c4833db25e35", "plan": {"physical": [...], "logical": [...]}, ...}
{"type": "query.progress", "query_id": "...", "elapsed_ms": 1500.2, "nodes": {"4294967297": {"rows_sent": 1048576, "total_time_ns": 812000000, ...}}}
{"type": "query.finished", "query_id": "...", "profile": { ...the same document the JSONL exporter writes... }}
```

| Event | When | Holds |
| --- | --- | --- |
| `process` | Once, when the file is first written by a process | Host, process id, polars-telemetry version |
| `query.started` | At a query's first sample, one second in | Its plan, label, call site and fingerprint. A query that finishes sooner has no `started` or `progress` events, only `finished` |
| `query.progress` | At every sample while it runs | The counters of each node that changed since the previous sample. Counters are cumulative: a node's latest entry is its state at that moment, and one dropped sample loses nothing. A counter that is zero is left out |
| `query.finished` | When it ends | The complete [profile](jsonl.md#what-you-get), as the JSONL exporter writes it |

Samples are taken every `Config.progress_interval` seconds, 1 by default, for
as long as the query runs. One background thread takes them for every running
query and hands each sample to every exporter that follows running queries.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `path` | required | The file; its directory is created. A name ending in `.gz` is written gzip-compressed |
| `max_bytes` | 256 MiB | Past this, the file moves to `<name>.1` and a new one starts |

Use `.gz`: progress samples of a large plan are big and compress well. A
compressed file is written in batches, at most two seconds apart and at the
end of every query, each a complete gzip member, so a file whose process died
can still be read up to its last batch.

## Your data

The same as the [JSONL exporter](jsonl.md#your-data): everything the plans
contain, with URL query strings masked, and masking configured the same way.
Progress samples hold counters only. The `process` line holds the host name.

## Cost

A sample takes well under a millisecond for a plan of a dozen nodes and about
15 ms for 500 nodes, on a background thread; measured wall times stayed within
run-to-run noise. Nothing is sampled while no exporter that follows running
queries is installed. How large a file grows depends on the plan's size and on
how long queries run.

## When it fails

An event that cannot be built or written is skipped and the first such error
logged. The exporter retries on the next event.
