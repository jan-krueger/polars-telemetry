# Running Nunatak

## Settings

Every setting is a flag or an environment variable; a flag wins.

| Flag | Variable | Default | Effect |
| --- | --- | --- | --- |
| `--bind` | `NUNATAK_BIND` | `127.0.0.1:7766` | Address of the dashboard, and of receiving events unless `--ingest-bind` is set. The default lets only this machine connect |
| `--ingest-bind` | `NUNATAK_INGEST_BIND` | none | A separate address that only receives events, see [Sharing it with a team](#sharing-it-with-a-team) |
| `--data` | `NUNATAK_DATA` | `nunatak-data`; `/data` in Docker | The folder for everything Nunatak keeps |
| `--keep-days` | `NUNATAK_KEEP_DAYS` | every run is kept | Delete runs that started more than this many days ago |
| `--token` | `NUNATAK_TOKEN` | created on first start | The token processes must send with their events |
| | `NUNATAK_LOG` | `info` | How much it logs: `warn`, `info` or `debug` |

`nunatak --help` lists them too. It logs to standard error and stops on Ctrl-C
or `SIGTERM`.

## The token

Every batch of events must carry the token, and a batch without it is
refused. The dashboard does not need it.

Without `--token`, Nunatak creates a random token on its first start and keeps
it in the `token` file of its data folder, readable only by its owner. To
replace it, delete the file and restart, or set `--token`. A process that
sends a wrong token stops sending for the rest of its life and logs a warning;
Nunatak logs the first refusal from each address, then stays quiet about that
address for ten minutes.

## Sharing it with a team

The dashboard has no login. Anyone who can reach its address sees every query,
with its plans: column names, file paths and, unless you
[mask them](../privacy.md), the literal values in filters. That is why it
listens on `127.0.0.1` unless told otherwise. Choose one of these to let others
in:

- **An SSH tunnel** for a few people with access to the machine:
  `ssh -L 7766:127.0.0.1:7766 nunatak-host`, then open
  `http://localhost:7766`.
- **A login in front of it.** Keep Nunatak on `127.0.0.1` and put a reverse
  proxy that asks for a login in front, such as
  [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) for your
  company's single sign-on, or a web server with a password. The live pages use
  server-sent events; behind nginx, turn off buffering for `/api/live` with
  `proxy_buffering off;`.

Processes on other machines need to reach the events address, not the
dashboard. Give that its own address, which serves only `/v1/events` and
`/v1/health`:

```console
$ ./nunatak --bind 127.0.0.1:7766 --ingest-bind 0.0.0.0:7767
```

and send to `http://nunatak-host:7767`. The token travels unencrypted over
plain HTTP; outside a network you trust, put a TLS proxy in front of that
address too.

### In Docker

The image listens on every address inside the container, so which addresses
reach it depends on how you publish the port. Publish it on `127.0.0.1`, as in
`-p 127.0.0.1:7766:7766`: `-p 7766:7766` opens it to every network the machine
is on, and Docker's port rules bypass firewalls such as `ufw`. With a separate
events address:

```console
$ docker run -d --name nunatak \
    -e NUNATAK_INGEST_BIND=0.0.0.0:7767 \
    -p 127.0.0.1:7766:7766 -p 7767:7767 \
    -v nunatak-data:/data ghcr.io/jan-krueger/nunatak:0.1.0
```

The image runs as user `65532`. A named volume, as above, works as it is; a
folder of the host mounted at `/data` must be writable by that user
(`chown 65532:65532`).

### As a service

A systemd unit that keeps 30 days in `/var/lib/nunatak`:

```ini
[Unit]
Description=Nunatak
After=network.target

[Service]
ExecStart=/usr/local/bin/nunatak --data /var/lib/nunatak --keep-days 30
DynamicUser=yes
StateDirectory=nunatak
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## What it keeps

Everything is in the data folder:

| Path | Holds |
| --- | --- |
| `index.db` | One row per query, with what the lists show and filter by. SQLite, with `index.db-wal` and `index.db-shm` next to it while it runs |
| `recordings/<year>/<month>/<day>/` | Every query that ended: its events as one `.jsonl.gz` file, the format of the [events exporter](../exporters/events.md), which the [profile viewer](../profile-viewer.md) opens |
| `live/` | The events of queries still running |
| `token` | The token, unless set with `--token` |

A run takes from about 5 KB, for a short query with a small plan, to a few
megabytes, for a query that runs for minutes with hundreds of nodes. Its size
grows with the plan and with how long it runs, since every second adds a sample
of the counters that changed.

With `--keep-days`, runs that started longer ago than that are deleted when
Nunatak starts and every hour after, their recordings with them. A running
query is never deleted.

## Backups and upgrades

To back it up, stop Nunatak and copy the data folder. While it runs, copy the
index with `sqlite3 index.db ".backup index-copy.db"`, then the `recordings`
folder.

To upgrade, stop it, replace the program or the image, and start it with the
same data folder. Nunatak updates the index to its own version when it starts;
keep a backup to go back to the version before.

## When something fails

| What happens | What you see |
| --- | --- |
| A process stops while a query runs | The query is closed as unfinished about a minute after its last event, with everything it sent |
| Nunatak stops or restarts | Processes keep their events and send them when it is back, for up to ten minutes. Queries that ran meanwhile are recorded whole |
| The disk is full or not writable | Nunatak refuses batches with `503` and logs why; processes send them again later. What it accepted before is kept |
| Nunatak crashes | Nothing it accepted is lost |
| The machine loses power | The last few seconds of what it received may be lost: Nunatak leaves writing to the disk to the operating system, so that it can take many batches at once |
| A recording is damaged or deleted | The run's page says so and shows what can still be read |

`GET /v1/health` answers `200` while Nunatak runs, for container and load
balancer checks; it is on the events address.
