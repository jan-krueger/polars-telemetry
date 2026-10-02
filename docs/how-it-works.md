# How it works

## The hook

polars imports a module named `polars_cloud` and reads `QueryCloudObserver`
off it **by name**, then duck-types the result. It never checks the type. So
this package supplies that name.

If the real `polars-cloud` is installed, its factory is kept and forwarded to.
Otherwise a module is registered in `sys.modules` under that name — we never
publish a distribution called `polars_cloud`, which would collide with theirs.

The protocol, verified against polars 1.44.1 and 1.44.2:

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

## Why there are no per-node spans

The counters are cumulative. None of the twenty fields is a timestamp, and the
protocol has no per-node events — a proxy logging every attribute polars looked
up confirmed there is nothing else to opt into.

So a node interval could only be *sampled*. That was built, measured, and
removed:

| Mode | Median | vs baseline |
| --- | --- | --- |
| no instrumentation | 37.8 ms | — |
| one snapshot at close | 38.5 ms | +2.0% |
| polling, 25 ms | 39.6 ms | +4.7% |
| polling, 5 ms | 43.5 ms | +15.1% |

The output did not justify the cost either. On a 48 ms query sampled at 5 ms,
eight of eleven nodes collapsed onto two identical windows — the "timeline" was
mostly quantisation. Fidelity depends on samples *per query*, so it only works
on long ones, and streaming nodes genuinely overlap, which makes a waterfall the
wrong mental model regardless of resolution.

Read once at query end, the same counters are **exact**. If polars ever exposes
per-node timestamps, node spans become exact and free, and they go back in.

## Failure isolation

Instrumentation runs inside your data path, so nothing here may surface as an
exception in your query. Every callback is wrapped: errors are counted, each
distinct one logged once, and past a threshold the hook disarms itself for the
rest of the process.

```text
polars-telemetry: disabling observer after 5 errors. Queries are unaffected.
```

`on_query_planned` is a special case — polars calls `close()` on whatever it
returns, so it always returns a guard even when it has failed internally.
