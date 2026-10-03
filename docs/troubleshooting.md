# Troubleshooting

## Nothing shows up in my tracing backend

- **No OpenTelemetry SDK.** The package depends on the OpenTelemetry API, whose
  default providers discard everything. Install the SDK and set a tracer
  provider before `install()`; see
  [OpenTelemetry](exporters/opentelemetry.md#set-up).
- **`install()` returned `None`.** This polars cannot be instrumented; the
  warning logged says why. See [Compatibility](internals/compatibility.md).
- **A different exporter was passed.** `install(exporter=...)` replaces the
  default. Include `OTelExporter(config)` in the list.

## Spans have no per-node counters

- **The query did not run on the streaming engine.** Eager `DataFrame`
  operations and `collect(engine="in-memory")` give polars-telemetry no
  physical plan and no counters; `polars.engine` says `in-memory`. Leave
  `engine` unset, or pass `"streaming"`.
- **`Config(node_metrics=False)`.** Counters are not read.
- **The polars version changed the counter format.** The probe at `install()`
  then keeps query spans only and logs a warning.

## Counters look too low

`polars.metrics.complete` is false: polars closed the query before every node
had reported, so the counters are lower bounds. This happens most on queries
that fail.

## A warning about a node kind it does not recognise

```text
polars-telemetry: polars sent a plan node of kind 'X', which this version does not recognise
```

A newer polars added or renamed an operator. Queries are unaffected, and the
node still appears in spans and profiles; only attributes that depend on
knowing what it does are missing. Updating polars-telemetry usually fixes it.

## "disabling exporter … after 5 errors"

An exporter raised five times and was switched off for the rest of the
process. The first error of each kind was logged before this; look there for
the cause. Your queries were not affected, and other exporters keep working.

## A login prompt appears when I call `install()`

`polars-cloud` is installed, and polars calls its `authenticate()` when
monitoring is enabled. See [Polars Cloud](polars-cloud.md).

## Queries run differently after `install()`

On polars 1.44, enabling monitoring sets the engine affinity to `"streaming"`,
the only engine that reports per-node counters. `uninstall()` puts the previous
affinity back, unless you chose another engine while it was installed. Pass
`engine=` to `collect()` where a single query must run on a specific engine.
polars 2 runs lazy queries on the streaming engine by default, so there
`install()` changes nothing.

## The viewer forgets my sessions

The browser is not keeping site data, as in a private window or with the page
opened from disk. The viewer says so in the sidebar. Open the files again, or
use the [hosted viewer](viewer/index.html).
