# Write your own

Any object with an `export(query)` method is an exporter.

## Use it when

- The data should go somewhere none of the bundled exporters reach: a
  database, a queue, an in-house metrics client.
- You want to act on queries as they finish, such as flagging slow ones.

## Set up

```python
import logging

import polars_telemetry
from polars_telemetry.model.types import Query

log = logging.getLogger("slow_queries")


class SlowQueries:
    def __init__(self, threshold_ms: float) -> None:
        self.threshold_ms = threshold_ms

    def export(self, query: Query) -> None:
        if query.wall_ms > self.threshold_ms:
            log.warning("%s took %.0f ms", query.label or query.fingerprint, query.wall_ms)


polars_telemetry.install(exporter=SlowQueries(threshold_ms=500))
```

## What you get

A [`Query`](../reference/api.md#polars_telemetry.model.types.Query) per
finished query, its findings included in `query.insights`. The JSONL exporter's
`build_profile(query)` in `polars_telemetry.export.profile` turns one into the
profile document, if a dictionary is easier to ship.

## Options

Whatever your exporter takes. `Config(redaction=...)` applies to yours too:
queries are masked before any exporter receives them, so `export()` never has
to. `redacted(SlowQueries(500), ...)` gives it a setting of its own.

## Your data

Everything the query carries, as for the other exporters. Where it goes from
there is up to you.

## Cost

`export()` runs on the thread that ran the query, after it finished, so its
time is added to the caller's. Hand slow work, such as network calls, to a
queue or a background thread.

An exporter that holds data, such as a buffer, can add a `close()` method.
`uninstall()` calls it, and so does the process on exit.

## When it fails

An exception from `export()` never reaches the query; see
[Failures stay contained](index.md#failures-stay-contained).
