# Nunatak

Nunatak is a dashboard for the queries of many processes, which you run
yourself. Your processes send it their queries while they run, with
[`HttpEventExporter`](../exporters/http-events.md), and it shows:

- **Now**: the queries running at this moment, across every process, each
  with the node that is busiest, and the ones that just finished.
- **Queries**: every query it has seen, grouped by label, with how often it
  ran, its typical and slow times, a trend of its recent runs, when its plan
  changed and the findings it raised. Filter by time, service, environment,
  host and status.
- **A run**: one query as the [profile viewer](../profile-viewer.md) shows it,
  both plans with their counters and findings, and a replay from start to end.
  A running query updates while you watch.

It is one program with no dependencies, and keeps everything in one folder on
its machine.

## Start it

Download the archive for your system from the
[releases](https://github.com/jan-krueger/polars-telemetry/releases) whose tag
starts with `nunatak-v`, for Linux (x86_64 and arm64) or macOS (Apple
silicon), and run it:

```console
$ tar -xzf nunatak-0.1.0-x86_64-unknown-linux-musl.tar.gz
$ ./nunatak
```

Or with Docker:

```console
$ docker run -d --name nunatak -p 127.0.0.1:7766:7766 -v nunatak-data:/data ghcr.io/jan-krueger/nunatak:0.1.0
$ docker logs nunatak
```

When it starts, it prints where it is:

```
Nunatak 0.1.0

  Dashboard  http://127.0.0.1:7766
  Data       /home/me/nunatak-data
  Token      in /home/me/nunatak-data/token
  Keeps      every run

Send events from Python with:

    import polars_telemetry
    from polars_telemetry.export import HttpEventExporter
    polars_telemetry.install(exporter=HttpEventExporter("http://127.0.0.1:7766", token="3f9c..."))
```

On its first start it creates a token, the password processes send their
events with, and prints it once. It stays in the `token` file of its data
folder.

## Send it queries

In the process whose queries you want to see:

```python
import polars_telemetry
from polars_telemetry.export import HttpEventExporter

polars_telemetry.install(
    exporter=HttpEventExporter("http://127.0.0.1:7766", service="orders-etl", environment="prod")
)
```

with the token in the `NUNATAK_TOKEN` environment variable, or passed as
`token=`. `service` and `environment` are what the dashboard filters by; the
host is added for you. Name queries with [labels](../labels.md) so that runs
of the same query are grouped together.

A query appears on **Now** once it has run for a second, and is kept when it
ends. One that ends sooner appears when it ends. Sending happens on a
background thread and never slows a query down; when Nunatak is away, the
exporter keeps the events and sends them later, see
[Events over HTTP](../exporters/http-events.md#when-the-server-is-slow-or-away).

## Add recordings you already have

Recordings written by the [events exporter](../exporters/events.md) can be
added to the history, compressed or not:

```console
$ ./nunatak import profiles/events.jsonl.gz
Imported 1840 events from 1 files; 0 were already there, 0 queries had not finished.
```

Pass the same `--data` folder Nunatak runs with. A file imported twice adds
nothing the second time.

## Next

- [Running Nunatak](running.md): settings, sharing it with a team, keeping
  data, backups.
- [HTTP API](api.md): what it receives and how to read its history from your
  own scripts.
