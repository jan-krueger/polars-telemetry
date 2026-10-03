# Getting started

## Install

```bash
pip install polars-telemetry          # API only; bring your own OTel SDK
pip install 'polars-telemetry[otlp]'  # with SDK and OTLP exporter
```

Requires Python 3.10+ and polars 1.44.1 – 1.44.x; see [Compatibility](compatibility.md).

## Activate

```python
import polars_telemetry

polars_telemetry.install()
```

!!! note "Activation is always explicit"
    `install()` enables polars' query monitoring, which sets the engine
    affinity to `"streaming"` and therefore changes how your queries execute —
    so it never happens on import. `uninstall()` does not restore the previous
    affinity; polars exposes no way to read it back.

`install()` is idempotent and returns the installation, including what the
capability probe found:

```python
state = polars_telemetry.install()
if state is None:
    ...  # this polars cannot be instrumented at all
else:
    print(state.capabilities.polars_version, state.capabilities.node_metrics_usable)
```

Eager `DataFrame` operations are instrumented too, but polars runs them off the
streaming engine, so they get a query span without per-node counters.

The same goes for a query collected with an explicit engine:
`collect(engine="in-memory")` overrides the affinity, and polars then gives the
observer no physical plan and no per-node counters. The span, its wall time and
the logical plan are still recorded. Leave `engine` unset, or pass
`"streaming"`, for the per-node view.

## Configure

```python
from polars_telemetry import Config

polars_telemetry.install(Config(node_metrics=False))
```

| Option | Default | Effect |
| --- | --- | --- |
| `node_metrics` | `True` | Read per-node counters once at query end |
| `include_plan` | `False` | Attach the full plan to the span as JSON |
| `call_site` | `True` | Record the file, line and function that ran the query |
| `redact_literals` | `False` | Mask literal values in plan expressions |
| `resource_attributes` | `{}` | Deprecated: never applied; set them on your OpenTelemetry provider |

## Label queries

```python
from polars_telemetry import label

with label("nightly"), label("revenue_by_region"):
    report.collect()
```

The label lands on the query's span and in its profile, where the viewer
shows and searches it. Nested labels join with `/`, so the query above is
`nightly/revenue_by_region`. A label is free-form and therefore never a metric
dimension.

## Profile a block of code

Where a global exporter is the wrong shape — a test, a notebook cell, one
function you are suspicious of — collect the queries directly:

```python
from polars_telemetry import profile

with profile() as session:
    report = build_report()

print(len(session), "queries")
print(session.slowest.call_site)
session.write("profiles/report.jsonl")  # open this in the viewer
```

| Member | Gives you |
| --- | --- |
| `session.queries` | every query, in order |
| `session.slowest` | the longest by wall time, or `None` |
| `session.wall_ms` | summed wall time (queries may overlap) |
| `session.profiles()` | the full profile document for each |
| `session.write(path)` | a session file the viewer opens |

The block installs instrumentation only if nothing was installed, and takes it
back out afterwards. With an application already installed it collects
*alongside* that exporter rather than replacing it, and blocks may nest.

!!! note "The scope is the process, not the thread"
    A block collects every query that finishes while it is open, including
    queries other threads ran.

## Send it somewhere

The package depends on the OpenTelemetry **API** only; your application owns
the SDK and decides where spans go.

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
trace.set_tracer_provider(provider)

import polars_telemetry

polars_telemetry.install()
```

## More than one destination

`exporter` takes several. Each receives every query, and one that keeps
failing disables itself without affecting the others:

```python
from polars_telemetry.export.file import FileExporter
from polars_telemetry.export.otel import OTelExporter

polars_telemetry.install(config, exporter=[OTelExporter(config), FileExporter("profiles/s.jsonl")])
```

`install()` is idempotent. Calling it again with different arguments logs a
warning and changes nothing; call `uninstall()` first.

## Debug without a collector

```python
from polars_telemetry.export.console import ConsoleExporter

polars_telemetry.install(exporter=ConsoleExporter())
```

```text
polars query 01a0fd9a ok wall=48.1ms cpu=235.3ms parallelism=4.90x nodes=11 rows_out=4
  at pipeline.py:142 in build_report()
  GroupBy              128.4ms  in=   3,134,012  out=           4
  Filter                79.4ms  in=   4,000,000  out=   3,134,012
  EquiJoin              0.73ms  in=   3,135,012  out=   3,134,012
```

## Polars Cloud

If `polars-cloud` is installed, its observer is wrapped and forwarded to rather
than replaced — both work at once. Enabling monitoring calls
`polars_cloud.authenticate()`, which is their function and may prompt a login.
