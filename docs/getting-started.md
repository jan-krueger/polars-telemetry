# Getting started

## Install

```bash
pip install polars-telemetry          # API only; bring your own OTel SDK
pip install 'polars-telemetry[otlp]'  # with SDK and OTLP exporter
```

Requires Python 3.10+ and polars 1.44.1 or newer.

## Activate

```python
import polars_telemetry

polars_telemetry.install()
```

!!! note "Activation is always explicit"
    `install()` enables polars' query monitoring, which sets the engine
    affinity to `"streaming"` — it changes how your queries execute. That is
    not a side effect an import may have, so there is no auto-activation.

    Disabling monitoring does not restore the previous affinity; polars exposes
    no way to read it back.

`install()` is idempotent and returns the installation, including what the
capability probe found:

```python
state = polars_telemetry.install()
if state is None:
    ...  # this polars cannot be instrumented at all
else:
    print(state.capabilities.polars_version, state.capabilities.node_metrics_usable)
```

`uninstall()` reverses it.

## Configure

```python
from polars_telemetry import Config

polars_telemetry.install(Config(node_metrics=False))
```

| Option | Default | Effect |
| --- | --- | --- |
| `node_metrics` | `True` | Read per-node counters once at query end |
| `redact_literals` | `False` | Mask literal values in plan expressions |
| `resource_attributes` | `{}` | Extra resource attributes |

## Send it somewhere

The package depends on the OpenTelemetry **API** only; the application owns the
SDK and decides where spans go. A minimal setup:

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

## Debug without a collector

```python
from polars_telemetry.export.console import ConsoleExporter

polars_telemetry.install(exporter=ConsoleExporter())
```

```text
polars query 01a0fd9a ok wall=48.1ms cpu=235.3ms parallelism=4.90x nodes=11 rows_out=4
  GroupBy              128.4ms  in=   3,134,012  out=           4
  Filter                79.4ms  in=   4,000,000  out=   3,134,012
  EquiJoin              0.73ms  in=   3,135,012  out=   3,134,012
```

## Using Polars Cloud too

If `polars-cloud` is installed, its observer is wrapped and forwarded to rather
than replaced — both work at once. Note that enabling monitoring calls
`polars_cloud.authenticate()`, which is their function and may prompt a login.
