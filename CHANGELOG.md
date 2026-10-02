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
- Sampling in `OFF`, `FINAL` and `INTERVAL` modes, with an adaptive settle on
  the closing snapshot rather than a fixed delay.
- Node windows derived from row-counter deltas, and an OpenTelemetry exporter
  emitting a query span, child spans per node and bounded-dimension metrics.
- Console exporter for debugging without OTel wiring.
