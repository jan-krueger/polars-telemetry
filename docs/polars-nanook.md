# Polars Nanook

Polars Nanook, formerly Polars Cloud, has its own query monitoring.
polars-telemetry works alongside its package; neither replaces the other.

| | While installed | After `uninstall()` |
| --- | --- | --- |
| With `polars-nanook` (or the older `polars-cloud`) | both receive every query; enabling monitoring calls its `authenticate()`, which may ask you to log in | Polars Nanook monitoring as it was |
| Without it | a stand-in module exists in `sys.modules`, so code that detects Polars Nanook by importing it is misled | the stand-in is removed |

The stand-in takes the name Polars imports: `polars_cloud` up to Polars 2.1,
`polars_nanook` after. polars-telemetry never publishes a package under either
name. The mechanism:
[How it works](internals/how-it-works.md).
