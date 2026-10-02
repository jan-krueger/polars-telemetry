# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Every per-node counter is now exported. Previously 14 of 16 never left the
  process; the set is now 14 instruments covering rows, morsels, polls,
  work-stealing, poll latency, state updates and IO time and bytes.
- `Config(include_plan=True)` attaches the full plan and its counters to the
  span as JSON. Off by default.

### Removed
- Interval sampling and per-node spans. polars exposes no per-node timestamps,
  so node intervals had to be sampled; measured at 5-15% overhead while
  collapsing most nodes onto identical windows. The same counters read once at
  query end are exact and cost nothing measurable.
- Console exporter for debugging without OTel wiring.
