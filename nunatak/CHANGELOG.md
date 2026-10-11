# Changelog

All notable changes to Nunatak are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Nunatak adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Its releases are
tagged `nunatak-vX.Y.Z`, apart from polars-telemetry's.

## [Unreleased]

## [0.1.0] - 2026-10-11

### Added
- A dashboard for the queries of many processes, which receives them from
  polars-telemetry's `HttpEventExporter` while they run: a home page of what
  changed in the last 24 hours, every query by label with its usual time, a
  page per query with its runs and plan versions, and each run in the profile
  viewer with a replay. Running queries update live.
- One binary for Linux (x86_64 and arm64, static) and macOS (Apple silicon),
  and an image `ghcr.io/jan-krueger/nunatak` for linux/amd64 and linux/arm64.
- Listens on 127.0.0.1:7766 by default; events are accepted only with the
  token set with `--token` or `NUNATAK_TOKEN`.
- Keeps everything in one folder, a SQLite index and the recordings;
  `--keep-days` deletes older runs.

[0.1.0]: https://github.com/jan-krueger/polars-telemetry/releases/tag/nunatak-v0.1.0
