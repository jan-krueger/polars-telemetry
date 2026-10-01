# Contract tests

Two halves, deliberately separate:

- **Golden** (`-m contract`) decodes the checked-in fixtures and asserts field
  names, types and plan shape. Fast, offline, catches regressions in our decoder.
- **Live** (`-m "contract and live"`) runs real queries against the installed
  polars and compares the captured shape against the fixtures. Catches changes
  in polars.

The live half is what the nightly canary runs against unreleased polars.
