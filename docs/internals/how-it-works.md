# How it works

## The hook

polars imports a module named `polars_cloud`, reads `QueryCloudObserver` from
it **by name** and duck-types the result without checking its type. This
package supplies that name.

If the real `polars-cloud` is installed, its factory is kept and forwarded to.
Otherwise a module is registered under that name in `sys.modules`. No
distribution called `polars_cloud` is published; it would collide with theirs.

The protocol, checked against every polars version in CI by `tests/contract`:

```text
polars_cloud.authenticate()
polars_cloud.QueryCloudObserver(workspace, organization) -> observer
observer.on_query_started(query_id: UUID)
observer.on_query_planned(query_id, handle, ir: bytes, phys: bytes) -> guard
observer.on_query_failed(...)
guard.close()
```

`ir` and `phys` are MessagePack plans. `handle` has exactly one public method,
`snapshot_query_metrics()`, returning MessagePack per-node counters keyed by
`phys_node_key` — the same ids as the physical plan, so metrics attribute to
nodes without any name matching.

## Failure isolation

No instrumentation error surfaces as an exception in your query. Every
callback is wrapped: errors are counted, each distinct one logged once, and
past a threshold the hook disarms itself for the rest of the process.

```text
polars-telemetry: disabling observer after 5 errors. Queries are unaffected.
```

`on_query_planned` always returns a guard, even when it failed internally,
because polars calls `close()` on whatever it returns.

## Why there are no per-node spans

polars' counters are cumulative, and no field of a metrics record is a
timestamp. A node interval could only be *sampled*:

| Sampling interval | Cost (share of query wall time) |
| --- | --- |
| 25 ms | 4.7% |
| 5 ms | 15.1% |

Sampling also resolves poorly: on a 48 ms query sampled at 5 ms, eight of
eleven nodes collapsed onto two identical windows.

Read once at query end, the counters are exact and cost nothing measurable.
If polars exposes per-node timestamps, node spans become exact and free, and
they go back in.

## Overhead

With a no-op exporter, the instrumentation stays below measurement noise on a
3M-row join and aggregation, interleaved against an uninstrumented run on the
same engine. The nightly canary runs this bench
(`tests/bench/test_overhead.py`) and opens an issue when it is over budget.

Exporters add their own cost, on the thread that ran the query; each
[exporter's page](../exporters/index.md) states it.
