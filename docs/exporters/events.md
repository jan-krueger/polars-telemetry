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

polars_telemetry.install(
    exporter=FileEventExporter("profiles/events.jsonl.gz", service="orders-etl", environment="prod")
)
```

It can run next to other exporters, such as the
[OpenTelemetry](opentelemetry.md) one; pass a list.

## What you get

One event per line. Every line has `"schema": "polars-telemetry/events@1"`, a
`seq` and a `type`:

```json
{"seq": 1, "type": "process", "id": "5f0c...", "service": "orders-etl", "environment": "prod", "host": "worker-3", "pid": 4711, "polars_telemetry_version": "0.9.0", "started_unix_ns": ...}
{"seq": 2, "type": "query.started", "query_id": "...", "profile": { ...its profile, without counters yet... }}
{"seq": 3, "type": "query.progress", "query_id": "...", "elapsed_ms": 1500.2, "nodes": {"4294967297": {"rows_sent": 1048576, "total_time_ns": 812000000, ...}}}
{"seq": 4, "type": "query.finished", "query_id": "...", "profile": { ...the same document the JSONL exporter writes... }}
```

The process line's `id` names the exporter's stream of events, and `seq` counts
the events in it, so a receiver can tell an event sent twice from a new one.

| Event | When | Holds |
| --- | --- | --- |
| `process` | When a process first writes to the file, and again at the top of a rotated file | The stream's id, the service and environment it was given, host, process id, polars-telemetry version |
| `query.started` | At a query's first sample, one second in | Its [profile](jsonl.md#what-you-get) so far: plans, label, call site, fingerprint and the wall time until then, with no counters yet. A query that finishes sooner has no `started` or `progress` events, only `finished` |
| `query.progress` | At every sample while it runs | The counters of each node that changed since the previous sample. Counters are cumulative: a node's latest entry is its state at that moment, and one dropped sample loses nothing. A counter that is zero is left out. While nothing changes, a sample with no nodes still comes every 5 seconds, so a reader can tell a quiet query from a dead process |
| `query.finished` | When it ends | The complete [profile](jsonl.md#what-you-get), as the JSONL exporter writes it |

Every event is described by a JSON Schema,
[`events-v1.schema.json`](../schemas/events-v1.schema.json), and the profile it
carries by [`profile-v1.schema.json`](../schemas/profile-v1.schema.json). Two
example recordings show a [finished query](../schemas/examples/finished.jsonl)
and [one the recording ended before](../schemas/examples/unfinished.jsonl). A
reader ignores fields and event types it does not know; a change that would break
that is a new version, `events@2`.

Samples are taken every `Config.progress_interval` seconds, 1 by default, for
as long as the query runs. One background thread takes them for every running
query and hands each sample to every exporter that follows running queries.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `path` | required | The file; its directory is created. A name ending in `.gz` is written gzip-compressed |
| `service` | `None` | What the process is, such as `"orders-etl"`; written on the process line |
| `environment` | `None` | Where it runs, such as `"prod"`; written on the process line |
| `max_bytes` | 256 MiB | Past this, the file moves to `<name>.1` and a new one starts with its own `process` line. A query running at that moment has its `started` event in `<name>.1`; open both files together |

Use `.gz`: progress samples of a large plan are big and compress well. A
compressed file is written in batches, when a query starts or ends and about
every two seconds in between, each a complete gzip member, so a file whose
process died can still be read up to its last batch.

## Viewing it

Open the file in the [profile viewer](../profile-viewer.md#replaying-a-recording),
compressed or not. Every query becomes a profile you can replay from its start
to its end; a query that was still running when the file ends shows the
counters of its last sample.

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
