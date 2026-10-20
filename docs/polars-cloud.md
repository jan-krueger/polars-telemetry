# Polars Cloud

polars-telemetry works alongside `polars-cloud`; neither replaces the other.

| | While installed | After `uninstall()` |
| --- | --- | --- |
| With `polars-cloud` | both receive every query; enabling monitoring calls `polars_cloud.authenticate()`, which may ask you to log in | Polars Cloud monitoring as it was |
| Without it | a stand-in `polars_cloud` module exists in `sys.modules`, so code that detects Polars Cloud by importing it is misled | the stand-in is removed |

Once Polars imports the package as `polars_nanook`, the stand-in takes that
name. polars-telemetry never publishes a package under either name. The
mechanism:
[How it works](internals/how-it-works.md).
