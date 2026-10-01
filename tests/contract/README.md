# Contract tests

- **Golden** (`-m contract`): decodes checked-in fixtures and asserts field
  names, types and plan shape. Offline; catches decoder regressions.
- **Live** (`-m "contract and live"`): runs real queries against the installed
  polars and compares against the fixtures; catches changes in polars. This is
  what the nightly canary runs.
