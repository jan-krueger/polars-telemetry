# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-03

### Added
- Repository scaffold: packaging, tooling, Docker development stack and CI.
- MessagePack decoding for the IR plan, physical plan and metrics payloads,
  with contract checks that describe how a payload departs from the known shape.
- Failure isolation: instrumentation errors are counted, logged once each, and
  disarm the hook past a threshold. Queries are never affected.
- Fixture capture tool and captured payloads for polars 1.44.2.
- Contract tests (golden and live) and a degradation suite covering renamed,
  added and retyped fields, corrupt payloads and callback arity changes.
- `install()` / `uninstall()`: binds the observer factory, enables monitoring,
  probes the installed polars and degrades to query spans only when the plan or
  metrics payloads are not as expected. Delegates to polars-cloud when present.
- Per-node counters read once when the query ends, with an adaptive settle on
  the closing snapshot rather than a fixed delay.
- OpenTelemetry exporter emitting one query span with plan-derived attributes,
  plus bounded-dimension metrics per node kind.
- User-facing attributes are read from the IR plan, which keeps the query's own
  column names; the physical plan rewrites group-by keys and aggregations to
  `_POLARS_TMP_N`.
- Overhead budget enforced in CI, measured by interleaving instrumented and
  uninstrumented runs so machine drift cancels.
- Documentation site (MkDocs Material), built with `--strict` in CI, with a
  test asserting the attribute reference documents every declared attribute.
- `polars.plan.fingerprint`: a hash of the plan *shape*, stable across
  parameter values and bounded by the application's code paths, so it is safe
  as a metric dimension where a query id is not.
- Derived diagnostics on the span: parallel efficiency, filter selectivity,
  join amplification, projection efficiency, morsel skew, predicate pushdown,
  row-group skipping and table statistics.
- `polars.metrics.complete`: false when the closing snapshot caught unfinished
  nodes, meaning the counters are a floor rather than a total.
- Every per-node field polars reports is exported, as 15 node instruments
  covering rows, morsels, polls, work-stealing, poll latency, state updates,
  and IO time and bytes. `largest_morsel` and `io_bytes` carry a `direction`
  dimension rather than one instrument per direction; stolen polls are exported
  as a ratio of total polls, and the per-node completion flag rides on the
  span as `polars.metrics.complete`.
- `Config(include_plan=True)` attaches the full plan and its counters to the
  span as JSON. Off by default.
- `FileExporter`: writes one self-contained profile per query to a JSON Lines
  session file, bounded by size with one retained generation. Carries both
  plans with node properties, all 19 counters per node, the diagnostics, the
  fingerprint, and the trace context when a span is active.
- A client-side profile viewer shipped with the docs site. Loads a session file
  in the browser with no upload, groups runs by fingerprint, renders both plans
  with per-node counters, and compares two runs of the same shape.
- `ConsoleExporter`: human-readable output for debugging without OTel wiring.

### Notes
- There are no per-node spans. polars exposes no per-node timestamps, so a node
  interval can only be sampled; sampling measured at 5-15% of query wall time
  and collapsed most nodes onto identical windows. The same counters read once
  at query end are exact and cost nothing measurable.

[0.1.0]: https://github.com/jan-krueger/polars-telemetry/releases/tag/v0.1.0
