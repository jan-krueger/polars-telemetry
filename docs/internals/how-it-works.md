# How it works

## The hook

Polars looks up `QueryCloudObserver` **by name** in the Polars Nanook module
(formerly Polars Cloud) and duck-types what it gets.

| | Module |
| --- | --- |
| Polars 2.1 and older | `polars_cloud` |
| Newer Polars | `polars_nanook` |

| `polars-nanook` or `polars-cloud` | polars-telemetry |
| --- | --- |
| installed | keeps its factory and forwards every callback to it |
| not installed | registers a stand-in module under that name in `sys.modules` |

No package under either name is published; it would collide with theirs.

The protocol, checked against every Polars version in CI by `tests/contract`:

```text
polars_cloud.authenticate()
polars_cloud.QueryCloudObserver(workspace, organization) -> observer
observer.on_query_started(query_id: UUID)
observer.on_query_planned(query_id, handle, ir: bytes, phys: bytes) -> guard
observer.on_query_failed(...)
guard.close()
```

- `ir`, `phys`: the logical and physical plan, as MessagePack.
- `handle.snapshot_query_metrics()`: MessagePack counters per node, keyed by
  `phys_node_key`, the physical plan's node ids. No name matching.

## Failure isolation

- Every callback is wrapped: an error in polars-telemetry never reaches your
  query.
- Each distinct error is logged once. After 5, the hook disarms for the rest of
  the process:

  ```text
  polars-telemetry: disabling observer after 5 errors. Queries are unaffected.
  ```

- `on_query_planned` returns a guard even when it failed, because Polars calls
  `close()` on whatever it returns.

## Why there are no per-node spans

Polars' counters are cumulative and carry no timestamps, so node intervals could
only be sampled:

| Sampling interval | Cost, share of wall time |
| --- | --- |
| 25 ms | 4.7% |
| 5 ms | 15.1% |

At 5 ms, 8 of the 11 nodes of a 48 ms query fell onto 2 identical windows.
Counters read once at query end are exact and cost nothing measurable. Node
spans return if Polars exposes per-node timestamps.

## Overhead

Measured nightly by `tests/bench/test_overhead.py`: no-op exporter, streaming
engine, interleaved with uninstrumented runs.

| | Budget | Measured |
| --- | --- | --- |
| Fixed cost per query, 2M-row join and aggregation | under 6 ms | about 1.5 ms |
| Share of wall time, 20M-row query | under 10% | about 1.5% |

The fixed cost is the profile, traits, findings and masking built when a query
ends, on the thread that ran it. Exporters add their own cost; each
[exporter's page](../exporters/index.md) says where it runs.
