# Troubleshooting

## Nothing shows up in my tracing backend

- **No OpenTelemetry SDK.** The package depends on the OpenTelemetry API, whose
  default providers discard everything. Install the SDK and set a tracer
  provider before `install()`; see
  [OpenTelemetry](exporters/opentelemetry.md#set-up).
- **`install()` returned `None`.** This Polars cannot be instrumented; the
  warning logged says why. See [Compatibility](internals/compatibility.md).
- **A different exporter was passed.** `install(exporter=...)` replaces the
  default. Include `OTelExporter(config)` in the list.

## Spans have no per-node counters

- **The query did not run on the streaming engine.** Eager `DataFrame`
  operations and `collect(engine="in-memory")` give polars-telemetry no
  physical plan and no counters; `polars.engine` says `in-memory`. Leave
  `engine` unset, or pass `"streaming"`.
- **`Config(node_metrics=False)`.** Counters are not read.
- **The Polars version changed the counter format.** The probe at `install()`
  then keeps query spans only and logs a warning.

## Counters look too low

`polars.metrics.complete` is false: Polars closed the query before every node
had reported, so the counters are lower bounds. This happens most on queries
that fail.

## A warning about a node kind it does not recognise

```text
polars-telemetry: polars sent a plan node of kind 'X', which this version does not recognise
```

A newer Polars added or renamed an operator. Queries are unaffected and the
node still appears in spans and profiles; only attributes that depend on its
kind are missing. Updating polars-telemetry usually fixes it.

## "disabling … after 5 errors"

| The message names | Means |
| --- | --- |
| an exporter, such as `ConsoleExporter` | that exporter is off for the rest of the process; the others continue. See [Failures stay contained](exporters/index.md#failures-stay-contained) |
| the observer | all telemetry is off for the rest of the process |

Queries are unaffected. The first error of each kind was logged before this
message, with the cause.

## My Config or exporter change has no effect

`install()` was called while already installed, as in a re-run notebook cell,
and logged that it ignores the new arguments. Call `uninstall()` first.

## A login prompt appears when I call `install()`

`polars-cloud` is installed, and Polars calls its `authenticate()` when
monitoring is enabled. See [Polars Cloud](polars-cloud.md).

## Queries run differently after `install()`

`install()` sets the engine affinity to `"streaming"`, which Polars' monitoring
requires. Polars 2 runs lazy queries there already; on Polars 1.44 it changes
the engine. `uninstall()` restores the previous affinity, unless you changed it
meanwhile. Pass `engine=` to `collect()` where a single query must run on a
specific engine.

## The viewer forgets my sessions

The browser keeps no site data, as in a private window or with the page
opened from disk; the viewer says so in the sidebar. Open the files again, or
use the [hosted viewer](viewer/index.html). See [Sessions](profile-viewer.md#sessions).
