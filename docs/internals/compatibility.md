# Compatibility

## Supported versions

**polars 1.44.1 and newer 1.44.x, and polars 2.x**, Python 3.10+.

Tested on every polars version in the CI matrix
([`ci.yml`](https://github.com/jan-krueger/polars-telemetry/blob/main/.github/workflows/ci.yml)),
and nightly on the newest polars, pre-releases included.

| | polars 1.44 | polars 2 |
| --- | --- | --- |
| `install()` | switches lazy queries to the streaming engine; `uninstall()` restores it | changes nothing: streaming is the default |
| Custom node metrics | none | per node, such as a group-by's group counts |
| Repeated plugin calls | never shared | shared unless registered with `is_deterministic=False` |
| `LazyFrame.profile()` | available | removed; use [`profile()`](../labels.md#scope-a-block-of-code) |

## On an unknown polars

`install()` runs a capability probe: a trivial monitored query whose payloads
are checked against the known contract. It costs milliseconds and runs once.

| Probe result | Behaviour |
| --- | --- |
| Everything as expected | Full instrumentation |
| Plan or metrics payloads off-contract | Query spans only, with a warning |
| IR payload off-contract | Full instrumentation; plan attributes use polars' internal names (`_POLARS_TMP_N`), with a warning |
| Callbacks never fire | Not installed, with a warning; `install()` returns `None` |
| No monitoring API at all | Not installed, with a warning |

Your queries keep working in every case.

What `install()` returns: [Getting started](../getting-started.md#watch-every-query-as-it-runs).

## Breaking changes

A nightly CI job runs the live contract test against the newest polars,
pre-releases included, and opens an issue on failure.

The hook is a private arrangement between two first-party packages. If polars
removes or changes it, the probe degrades or declines; queries keep running
while the package emits less, or nothing.
