# HTTP API

## Receiving events

Processes send their events to `POST /v1/events`, as
[`HttpEventExporter`](../exporters/http-events.md#what-it-sends) does: a batch
of [`polars-telemetry/events@1`](../exporters/events.md#what-you-get) events
from one process, `process` event first, as JSON Lines, gzip-compressed with
`Content-Encoding: gzip` or plain, with the token as
`Authorization: Bearer <token>`. Anything that writes that format
can send to Nunatak.

| Answer | When | Body |
| --- | --- | --- |
| `202` | Every event is stored, or was already | `{"accepted": 12, "duplicates": 0}` |
| `400` | The body is not valid gzip, or not events@1 | `{"error": "...", "line": 3}`, the line when one is to blame |
| `401` | The token is missing or wrong | `{"error": "missing or wrong token"}` |
| `413` | Over 8 MiB compressed or 64 MiB once decompressed | `{"error": "..."}`; split the batch |
| `503` | Storing it failed, with `Retry-After` | `{"error": "storage failed; send again"}` |

An event is known by its stream's `id` and its `seq`, so a batch sent again,
whole or in part, stores each event once.

`GET /v1/health` answers `{"status": "ok", "protocol": ["polars-telemetry/events@1"]}`
without a token.

## Reading the history

The dashboard reads everything through the API below, on the dashboard's
address and without a token. Your own scripts can use it too; until Nunatak
1.0 it can change between versions, as the changelog will say.

Times are Unix nanoseconds, durations milliseconds. Every list takes the same
filters, each optional:

| Parameter | Keeps queries |
| --- | --- |
| `label`, `fingerprint` | With this label or plan fingerprint |
| `service`, `environment`, `host` | From processes with this value |
| `status` | `running`, `finished`, `failed` or `unfinished` |
| `since`, `until` | That started at or after, at or before this time |

### `GET /api/queries`

The queries, newest first or with `order=oldest` oldest first, 100 at a time:
`limit` takes up to 1000, `offset` skips. Each is a summary:

```json
{
  "query_id": "01a12532-7bcd-7082-8a3f-bd94907497ea",
  "stream_id": "5f0c2b1e-...",
  "project": "default",
  "service": "orders-etl",
  "environment": "prod",
  "host": "worker-3",
  "label": "orders/daily_totals",
  "fingerprint": "8c41f0a2d9e7",
  "status": "finished",
  "started_unix_ns": 1791712345000000000,
  "wall_ms": 1840.5,
  "cpu_ms": 9120.2,
  "result_rows": 365,
  "failed": null,
  "warnings": 1,
  "rules": ["in_memory_fallback"],
  "recording": "2026/10/11/01a12532-7bcd-7082-8a3f-bd94907497ea.jsonl.gz"
}
```

`rules` names the [insights](../insights.md) that warned. `failed` holds
Polars' error when the query failed.

### `GET /api/queries/{id}`

One query's summary, or `404`.

### `GET /api/queries/{id}/recording`

The query's events, gzip-compressed JSON Lines, for the
[profile viewer](../profile-viewer.md) or your own reader. `404` while it runs.

### `GET /api/groups`

The queries grouped by `by=label` (the default) or `by=fingerprint`, the group
run most recently first:

```json
{
  "key": "orders/daily_totals",
  "runs": 214,
  "failed": 2,
  "last_started_unix_ns": 1791712345000000000,
  "total_wall_ms": 401233.0,
  "rules": ["in_memory_fallback"],
  "recent_wall_ms": [1802.1, 1840.5]
}
```

`recent_wall_ms` holds the wall times of the last 30 runs that finished, oldest
first.

### `GET /api/overview`

Each label that ran in the last `days` × 24 hours (14 days unless given, up to
90), with its time lately against its usual time. `days` lists where each local
day the range touches starts, the first possibly before `since_unix_ns`;
`utc_offset`, minutes ahead of UTC, sets where days start. Takes `service`, `environment`, `host` and `label`.

```json
{
  "now_unix_ns": 1791712345000000000,
  "since_unix_ns": 1790502745000000000,
  "days": [1790460000000000000, ...],
  "queries": [{
    "label": "orders/country_mix",
    "service": "orders-etl",
    "runs": 336, "failed": 0, "total_wall_ms": 171400.0,
    "usual_wall_ms": 324.0, "usual_band_ms": [298.0, 351.0],
    "recent_wall_ms": 1786.0, "ratio": 5.5, "verdict": "slower",
    "recent_runs": 24, "recent_failed": 0, "failed_before": 0,
    "rules": [], "new_rules": [], "plan_changed_unix_ns": 1791557160000000000,
    "bins": [312.0, 330.5, ...],
    "days": [{"runs": 24, "failed": 0, "median_wall_ms": 318.0}, ...]
  }]
}
```

Lately means the runs of the last 24 hours, or the last three when there were
fewer; usual means the finished runs of the 14 days before them. `verdict` is
`slower` or `faster` when the median moved by 1.5× or more and a one-sided
Mann-Whitney test puts the chance of that by luck under 1%; otherwise `null`.
`new_rules` are warnings first seen in the last 7 days, and
`plan_changed_unix_ns` is when the plan the query runs now first ran, if it
is not the plan it usually ran. `bins` holds the median time of equal slices of
the range, `days` one entry per day.

### `GET /api/versions`

Each plan a `label` finished with at least once, the one that ran last first: `fingerprint`,
`runs`, `failed`, `first_started_unix_ns`, `last_started_unix_ns`,
`usual_wall_ms`, `rules` and `latest_query_id`. Takes `since` and `until`.

### `GET /api/facets`

Each value of `service`, `environment`, `host` and `status`, and how many
queries have it. Each field is counted under the other fields' filters, so a
filter on `service` leaves every service listed.

```json
{
  "service": [{"value": "orders-etl", "runs": 1904}, {"value": "reports", "runs": 1210}],
  "environment": [{"value": "prod", "runs": 3114}, {"value": null, "runs": 802}],
  "host": [...],
  "status": [...]
}
```

### Live updates

Two [server-sent event](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
streams follow running queries:

| Stream | Sends |
| --- | --- |
| `GET /api/live` | `snapshot` with the running queries and their latest samples, then `query` when one starts or ends and `pulse` with each new sample |
| `GET /api/live/{id}` | `events` with the query's events so far, then each new batch as it arrives, then `finished` with its summary when it ends |
