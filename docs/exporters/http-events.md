# Events over HTTP

`HttpEventExporter` sends the same events the [events exporter](events.md)
writes to a file, while each query runs, to a server: the query and its plan
once it has run for a second, a sample of every changed node's counters after
that, and its full profile when it finishes.

Use it when:

- Several processes or machines should report to one place.
- You want to watch queries while they run, not only read a file afterwards.

## Set up

```python
import os

import polars_telemetry
from polars_telemetry.export.http_events import HttpEventExporter

polars_telemetry.install(
    exporter=HttpEventExporter(
        "http://localhost:7766",
        token=os.environ["EVENTS_TOKEN"],
        service="orders-etl",
        environment="prod",
    )
)
```

| Option | Default | Effect |
| --- | --- | --- |
| `url` | required | The server. Events are posted to `{url}/v1/events` |
| `token` | required | Sent as `Authorization: Bearer <token>` |
| `service` | `None` | What the process is, such as `"orders-etl"` |
| `environment` | `None` | Where it runs, such as `"prod"` |
| `max_queue_bytes` | 16 MiB | Events waiting to be sent beyond this are dropped, progress samples first |
| `timeout` | 10 s | How long to wait for the server on each request |

## What it sends

Each request is a batch of [`polars-telemetry/events@1`](events.md#what-you-get)
events, the format of an events file, gzip-compressed JSON Lines with the
`process` event first:

```
POST /v1/events
Authorization: Bearer <token>
Content-Type: application/x-ndjson
Content-Encoding: gzip
```

A batch goes out when a query starts or ends, and about every two seconds in
between. Every event keeps its `seq` when sent again, so a server can drop an
event it already has.

## When the server is slow or away

Sending happens on one background thread; a query never waits for the server.

| The server answers | The exporter |
| --- | --- |
| 2xx | Moves on |
| 429, 503, other 5xx, or nothing | Sends the batch again, after `Retry-After` or a growing pause up to 30 s; an event older than ten minutes is dropped |
| 413 | Splits the batch and sends the halves |
| 401 or 403 | Stops sending for the rest of the process |
| any other 4xx | Drops the batch |

The first problem of each kind is logged as a warning; `errors` counts failed
requests and `dropped` the events that were never sent. On `uninstall()` and at
exit, what is queued is sent for at most two seconds.

## Your data

The same as the [events exporter](events.md#your-data), except that it leaves
the machine. To mask literal values or paths before they are sent, use
`Config(redaction=Redaction())` for every exporter, or
`redacted(HttpEventExporter(...), Redaction())` for this one; see
[Privacy](../privacy.md).
