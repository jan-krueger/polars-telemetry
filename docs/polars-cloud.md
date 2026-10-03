# Polars Cloud

polars-telemetry works alongside `polars-cloud`; neither replaces the other.

polars looks up an observer for its cloud product by name, and polars-telemetry
attaches there. When `polars-cloud` is installed, polars-telemetry keeps its
observer and passes every event on to it, so both receive every query, for
the workspace and organization you chose. `uninstall()` hands the observer
back, with Polars Cloud monitoring as it was.

With `polars-cloud` installed, enabling monitoring makes polars call
`polars_cloud.authenticate()`. That is Polars Cloud's own function, and it may
ask you to log in.

Without `polars-cloud`, nothing of it is needed or installed. polars-telemetry
never publishes a package named `polars_cloud`.

See [How it works](internals/how-it-works.md) for the mechanism.
