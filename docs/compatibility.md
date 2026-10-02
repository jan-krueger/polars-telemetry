# Compatibility

## Supported versions

**polars 1.44.1 and newer 1.44.x**, Python 3.10+.

The observer hook does not exist before 1.44.0, and 1.44.0's runtime is yanked,
so 1.44.1 is the floor.

polars is declared with a floor and no upper pin, so a newer polars never
causes a resolver conflict.

## On an unknown polars

`install()` runs a capability probe: a trivial monitored query whose payloads
are checked against the known contract. It costs milliseconds and runs once.

| Probe result | Behaviour |
| --- | --- |
| Everything as expected | Full instrumentation |
| Plan or metrics payloads off-contract | Query spans only, with a warning |
| Callbacks never fire | Not installed, with a warning; `install()` returns `None` |
| No monitoring API at all | Not installed, with a warning |

Your queries keep working in every case.

```python
state = polars_telemetry.install()
if state is None:
    ...  # this polars cannot be instrumented at all
else:
    print(state.capabilities.polars_version, state.capabilities.node_metrics_usable)
```

## Breaking changes

A nightly CI job installs the newest polars — pre-releases included — and runs
the live contract test against it, opening an issue on failure. The intent is
to learn about a breaking change while it is still a release candidate.

Everything rests on a private arrangement between two first-party packages. If
polars removes or changes it, the probe degrades or declines, and the package
keeps your queries running while emitting less — or nothing.
