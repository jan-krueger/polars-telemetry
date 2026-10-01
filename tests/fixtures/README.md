# Captured payloads

One directory per supported polars version, each holding the raw MessagePack
blobs the observer delivers plus their decoded JSON for review:

```
1.44.2/
  ir_plan.msgpack        physical_plan.msgpack        metrics.msgpack
  ir_plan.json           physical_plan.json           metrics.json
  meta.json              # polars version, query source, capture timestamp
```

Regenerate with `nox -s capture -- <version>`. The blobs are the contract:
`tests/contract/` asserts their shape, and the nightly canary compares a live
capture from the newest polars against them.

Never hand-edit. A diff here is the signal that polars changed something.
