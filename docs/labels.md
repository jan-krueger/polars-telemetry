# Label and scope queries

## Label queries

A label names the queries a block of code runs, so you can find them again:
in your tracing backend, in the console output, and in the viewer's search.

```python
from polars_telemetry import label

with label("nightly"), label("revenue_by_region"):
    report.collect()
```

Nested labels join with `/`, so this query is `nightly/revenue_by_region`.

| Where | How it appears |
| --- | --- |
| Span | `polars.query.label` |
| Profile | `"label"`, the query's title in the viewer |
| Console | the header, in place of the query id |
| Metrics | never: a free-form value would make unbounded metric series |

Each thread has its own labels, so concurrent work does not mix them up.
Labels need no exporter of their own and cost nothing when nothing is
installed.

!!! note "Not for `collect_async()` or `collect_batches()`"
    polars reports those queries from its own threads, where neither the
    label nor your call site is visible, so they arrive without both.

## Scope a block of code

`profile()` collects the queries a block of code runs, without setting up an
exporter for the whole process. polars 2 removed `LazyFrame.profile()`; this
covers the same ground, for every query a block runs, on either version. Useful in a test, a notebook cell, or around
one function you suspect:

```python
from polars_telemetry import profile

with profile() as session:
    report = build_report()

print(len(session), "queries,", session.wall_ms, "ms")
print(session.slowest.call_site)
session.write("profiles/report.jsonl")  # open this in the viewer
```

| Member | Gives you |
| --- | --- |
| `for query in session` | every query, in the order they finished |
| `session.slowest` | the longest by wall time, or `None` |
| `session.wall_ms` | summed wall time; queries may overlap |
| `session.profiles()` | each query as a profile document |
| `session.write(path)` | a session file the [viewer](profile-viewer.md) opens |

If nothing is installed, the block installs instrumentation and removes it
afterwards. If an application has already installed exporters, they keep
receiving every query; the block collects alongside them. Blocks may nest.

!!! note "The scope is the process, not the thread"
    A block collects every query that finishes while it is open, including
    queries other threads ran.

Combine the two to find one part of a larger job:

```python
with profile() as session, label("load"):
    load_inputs()
```
