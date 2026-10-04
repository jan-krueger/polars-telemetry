# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `polars-telemetry insights FILE…`: reads profile files and reports what
  slows their queries, ranked by the share of CPU or wall time each finding
  concerns. The first rules: `in_memory_fallback`, `exploding_join`,
  `cross_join`, `repeated_string_scan` and `redundant_aggregation`.
  `--format json`, `--fail-on` for CI, and `--write` to keep the findings in
  the profiles. See the new Insights page.
- `Config(insights=True)`: the same findings for every query as it runs,
  computed after its wall time is measured, and written to profiles as an
  `insights` field. A few milliseconds even for a plan of a thousand nodes;
  `Config(insights=False)` turns it off.

### Fixed
- A plugin's library path relative to the environment, which
  `register_plugin_function` writes by default, is now masked by
  `Redaction(paths=True)` and reduced to the library's name in the fingerprint.
  0.5.0 only recognised absolute paths, so the fingerprint of such a plan still
  depended on the Python version and platform. **Fingerprints of plans that call
  a plugin through a relative path inside an aggregation change once.**

## [0.5.1] - 2026-10-04

### Added
- `Config(describe_fallbacks=True)`: an in-memory fallback node now says what it
  runs, for example `col("v").rank().over([col("g")])`, in its `format_str`
  property and in the viewer under **Runs**. polars only writes this when
  `POLARS_STREAM_ALWAYS_PREPARE_VISUALIZATION_DATA=1`, an undocumented switch
  it added for Polars Cloud; `install()` sets it when unset and `uninstall()`
  removes it again, though polars keeps it on for the process once read. It
  costs a fraction of a millisecond per query.

### Fixed
- `polars.cpu_count` and `polars.parallel_efficiency` counted every core of the
  machine. They now use polars' thread pool, which honours CPU affinity, a
  systemd or container CPU quota and `POLARS_MAX_THREADS`. A query in a unit
  limited to 48 of 96 cores reported half its real efficiency.
- An undescribed in-memory fallback no longer carries polars' placeholder text
  `error: prepare_visualization was not set during conversion` into spans and
  profiles. The viewer shows "not recorded" for profiles written before.

## [0.5.0] - 2026-10-03

### Added
- `polars.join.growth` (`Diagnostics.join_growth`): the largest join's rows out
  over its larger input. Up to 2 is any ordinary join; above 2 takes keys that
  repeat on both sides. The viewer's chip shows it, computed from the plan for
  profiles written before it existed.
- Viewer: **Copy link** shares the query on screen, and the run it is compared
  with, as a link that carries the profiles itself, so nothing is uploaded. A
  link opens as a temporary session that **Keep** stores. Unmasked profiles ask
  before copying.
- Viewer: double-click a session's name, or press F2, to rename it.
- Viewer: edges in the physical plan are drawn thicker the more rows they carry,
  so where data shrinks or fans out shows at a glance.
- Viewer: a button in each plan's header shows that plan alone, across the
  full width.
- Viewer: a link button in the plans' headers pans and zooms both plans
  together, at the same zoom and at the same point along each plan.

### Changed
- Viewer: plans with hundreds of nodes lay out in the background, so the page
  stays responsive while a large plan opens, and a plan opened before is shown
  at once. Selecting a node no longer redraws the whole plan, and far zoomed
  out, nodes draw as plain boxes without labels.

### Deprecated
Removed in 0.6.0.
- `polars.join.amplification` (`Diagnostics.join_amplification`): use
  `polars.join.growth`. It divides by a join's first input, so a small table
  joined to a large one reads as fan-out (TPC-H q9 shows 7.5×). The viewer no
  longer shows it.

### Fixed
- `Redaction(paths=True)` now also masks the library path of an expression
  plugin, which appears in plan expressions as `/…/lib.so:function()`.
- The plan fingerprint counts an expression plugin by its library name, not by
  where it is installed, so the same query fingerprints the same in every
  environment. **Fingerprints of plans that call a plugin inside an aggregation
  change once.**
- `polars.scan.predicate_pushed` and `polars.scan.predicates` no longer count
  the thresholds polars pushes into a scan for a top-k or, on polars 2, a join
  (`dynamic_predicate()`) as the user's filter.
- 30 node kinds polars' streaming engine can emit, among them `StrptimeInfer`,
  `IsFirstDistinct`, `InMemoryJoin`, `SortedGroupBy`, `PythonScan` and the slice
  nodes, were logged as unrecognised and carried no role. They now map onto
  roles in both the exporter and the viewer.
- Viewer: a logical plan's predicate shows its conditions joined by `&`, laid
  out like the physical plan's, instead of as separate unconnected lines.
- Viewer: a join's inputs are drawn left to right in the order polars lists
  them, so the logical and physical plans are laid out alike instead of as
  mirror images.

## [0.4.0] - 2026-10-03

### Added
- Viewer: the hosted viewer loads a TPC-H example session with one click, so it
  can be tried without a workload of your own.
- Python 3.14 is supported, and tested in CI in place of 3.13 as the newest
  version.

### Changed
- The plan fingerprint no longer depends on literal values or on where a
  scanned file lives: literals are masked before hashing, and a file counts by
  its name with numbers and dates masked. Queries that differ only in a value
  or a dated file name share a fingerprint, as the docs promised, instead of
  starting a metric series each. **Fingerprints of plans with such literals or
  paths change once on upgrade**, and so do the metric series keyed on them.

### Removed
As announced in 0.3.0:
- `Config(redact_literals=True)`: use `Config(redaction=Redaction())`.
- `FileExporter(redact_literals=True)`: use
  `redacted(FileExporter(...), Redaction())`.
- `Config.resource_attributes`, which was never applied: set resource
  attributes on your OpenTelemetry provider.

### Fixed
- `Redaction(paths=True)` left the paths of written files readable: a sink's
  target in both plans. They are masked like scanned paths now.
- String literals containing a quote or ending in a backslash, such as a
  Windows path, threw off the masking, and other literals in the same
  expression stayed readable. polars prints such strings unescaped; they are
  now delimited by what may follow them.
- A `profile(config)` block inside an installation that masks data handed its
  session unmasked queries whenever `config` did not repeat the redaction. A
  session now masks everything the installation masks, plus what its own
  config adds.
- `polars.sort.columns` can carry literals, but was missing from
  `CARRIES_USER_DATA` and the documented list of attributes that do.
- When polars-cloud is installed and its observer fails, for instance on an
  expired session, polars-telemetry counted that against itself and stopped
  recording after five queries. It now logs the failure once and carries on.
- An `install()` that failed part-way, such as on an object without an
  `export` method in the exporter list, left monitoring on and its hook in
  place, and a retry then delivered every query several times. Arguments are
  now checked first, with a `TypeError`, and a failure undoes everything.
- With Polars Cloud monitoring on, `install()` sent its metrics to the default
  workspace instead of the chosen one, and `uninstall()` turned Polars Cloud
  monitoring off. Its workspace, organization and on/off state are now kept.
- The docs promised labels per asyncio task, but queries run with
  `collect_async()` or `collect_batches()` carry no label or call site: polars
  reports them from its own threads. The docs now say so.
- Had polars passed an observer callback a new argument, the callback would
  have raised before its own error handling ran. Callbacks now accept any
  arguments and unpack them inside it.
- Viewer: a profile with a malformed number, such as a counter given as text or
  an out-of-range start time, crashed the viewer on every load, and the only
  way out deleted every stored session. Such values are now dropped when read,
  and the error page offers to remove just the open session.
- Viewer: one failed save, such as a session too big for the browser's
  storage, switched storage off for the rest of the page, so sessions removed
  afterwards came back on the next load. A failed save or removal is now
  reported, and storage keeps working.
- Viewer: removing the open session showed the empty start page while other
  sessions were still stored. The next one opens now.
- Viewer: a profile without a `query_id` got a new random id on every load, so
  links, reload and the back button lost it, and one with an empty id could not
  be opened. Such profiles are now numbered by their place in the session.
- Viewer: plan nodes could be focused from the keyboard but not selected, so
  their details stayed out of reach. Enter or Space now selects them, and the
  remaining mouse-only tooltips can be reached with Tab.
- Viewer: laying out a long predicate took time quadratic in its length, and was
  redone on every render, so a node with thousands of conditions froze the tab
  for seconds at each keystroke. Layout is now linear and cached, and strings
  ending in a backslash no longer throw it off.
- Viewer: a profile written on Windows showed full paths where a file name
  belonged, in query titles, the call site and search.
- A `profile()` block opened before an `uninstall()` took down the installation
  of a block opened after it, which then collected nothing. Each block now
  releases only the installation it held.
- uv itself escaped the 7-day rule: CI installed the newest uv on every run,
  and the dev image named a 4-day-old uv by tag. Both now use uv 0.12.19, the
  image by digest.
- `uninstall()` left polars' engine affinity on `"streaming"`. It now puts back
  the affinity from before `install()`, engine objects such as `GPUEngine`
  included, unless the application chose another engine in the meantime.

## [0.3.1] - 2026-10-03

### Changed
- Per-node counts are summed per node kind before they are recorded, so the
  OpenTelemetry and DogStatsD exporters make fewer calls: 20% and 17% less time
  on a 22-node TPC-H query. Backends see the same totals. Times and ratios
  still record one value per node.

### Fixed
- `uninstall()` flushed exporters while holding its lock, so a slow flush, up
  to 2 s for DogStatsD, held up `install()` and `profile()` in other threads.
  Exporters are now closed after the lock is released.

## [0.3.0] - 2026-10-03

### Added
- `Redaction` chooses what is masked: `strings`, `numbers` and `temporal`
  (dates, datetimes, times, durations) by default, and `paths`, `call_site`
  and `labels` on request, plus a `custom` rule of your own. Set it with
  `Config(redaction=Redaction(...))`.
- `redacted(exporter, redaction)` gives one exporter its own setting, so a
  shared backend can receive a masked copy while a local file keeps every
  detail. `redacted(exporter, None)` sends that exporter everything.
- Profiles record what was masked in a `redacted` field, and the viewer shows
  it beside the query.
- `DogStatsdExporter`: the same metrics as OpenTelemetry, with tags, through
  Datadog's DogStatsD client, for the Datadog Agent or Telegraf. Metric names
  and tag keys can be renamed or left out, labels sent as a tag, and times
  sent as histograms for Telegraf. Install with `polars-telemetry[datadog]`.
- Exporters may have a `close()` method, which `uninstall()` and the process's
  exit call, so buffered data is sent.
- Viewer: a focus slider on the physical plan fades all but the most
  expensive nodes, a step at a time, in the plan and the minimap alike. It is
  kept as a share of CPU time, so it carries over between queries.

### Changed
- Viewer: tooltips appear on hover after a short pause and at once on keyboard
  focus, where the browser's own showed late and never for the keyboard.
- Masking happens once, before a query is delivered, and nowhere else.
  `OTelExporter` and `FileExporter` no longer mask on their own. An
  `OTelExporter` made with a masking config still masks when `install()` was
  given none, as before.

### Deprecated
All three are removed in 0.4.0.
- `Config(redact_literals=True)`: use `Config(redaction=Redaction())`, which
  it now sets.
- `FileExporter(redact_literals=True)`: use
  `redacted(FileExporter(...), Redaction())`.
- `Config.resource_attributes`, deprecated since 0.2.0 and never applied: set
  resource attributes on your OpenTelemetry provider.

### Fixed
- Masking left some literals readable: durations such as `5h`, the mantissa of
  numbers like `1.0000e-9`, and any literal followed by a method call, such as
  `1.5.alias("x")` or `2024-01-01.alias("d")`. Times came out as
  `<num>:<num>:<num>`, and digits inside file paths were masked piecemeal.

## [0.2.0] - 2026-10-03

### Added
- `label()`: a context manager naming the queries run inside it, so they can
  be found again. Nested labels join with `/` (`etl/customers`). The label is
  recorded on the span as `polars.query.label` and in the profile, and is
  never a metric dimension, being free-form.
- Viewer: queries are titled by their label, and a search box narrows the
  list by label, file, shape or fingerprint.
- Viewer: a stored session can be downloaded again as the `.jsonl` it was
  imported from.
- Viewer: query times carry a date when a session spans days, and show the
  exact UTC instant on hover; sessions list when their queries ran rather than
  when they were imported.
- Viewer: the overview sorts by query, runs, total wall or mean CPU; names
  sort as numbers read, so `q2` comes before `q10`.
- Viewer: the address bar names the session, query and node on screen, so a
  reload keeps the view and the back button returns to the previous query.
- `install(exporter=[...])` takes several exporters. Each receives every
  query, and one that keeps raising disables itself without costing the others.
- Each node in a profile carries its `role`, so a reader can render the plan
  without learning polars' kind names. Additive: `profile@1` readers that
  predate it are unaffected.
- `profile()`: a context manager collecting the queries run inside a block,
  with `slowest`, `wall_ms`, `profiles()` and `write()` for a viewer-ready
  session file. It registers a sink rather than replacing the exporter, so it
  composes with an existing installation and nests; it installs instrumentation
  only when nothing was installed, and removes it afterwards.
- Call-site attribution: every query carries the file, line and function that
  ran it, as OpenTelemetry's `code.file.path`, `code.line.number` and
  `code.function.name`, and in the profile and the viewer. Walking out to the
  first frame beyond polars costs well under a microsecond. Code with no file
  on disk — `exec`, the REPL, a notebook cell — reports nothing rather than a
  temporary name. Disable with `Config(call_site=False)`.

### Changed
- polars' callback protocol is isolated in `adapter/hook.py`, which translates
  each callback into a call on a recorder that assembles the query. The
  capability probe now runs through the same hook rather than its own copy of
  the protocol, so a change to polars' callbacks is a change in one module.
- The closing snapshot is not retried when the query failed, since a failed
  query's nodes never report done, nor when the snapshot carries no `done`
  flag at all. Either way the retries only added latency inside the caller's
  path.
- The plan fingerprint and the diagnostics are computed once, as a query
  arrives, and carried on `Query`; exporters read them rather than each
  deriving their own. The fingerprint is computed before any redaction, so it
  is the same whatever a receiver's privacy settings are.
- Exporters and `profile()` sessions are receivers in one registry, and the
  installation is changed under one lock. `install()` called again with
  different arguments now warns instead of silently ignoring them; called
  inside a `profile()` block it takes the installation over, where before the
  application's exporter received nothing for the rest of the process.
- `profile()` blocks that overlap on different threads keep instrumentation
  until the last one closes. Previously the block that happened to install it
  uninstalled it on closing, even with another block still open.
- `Config.resource_attributes` warns that it is deprecated. Nothing ever read
  it.
- The viewer reads every profile through one reader per schema version into
  its own typed model, and keeps the documents as written in browser storage,
  reading them again on each load: sessions stored today keep opening when the
  schema moves on, with no storage migration. A stored profile that no longer
  reads is dropped on its own instead of taking the viewer down.
- The viewer themes React Flow through the CSS variables it publishes rather
  than by overriding its internal class names, which removes the one
  `!important`. The four rules that have no variable are kept together, so an
  upgrade has one place to check.
- The viewer lays a plan out once per plan rather than on every click, and
  refits the view when a different query is picked; it kept the previous
  query's zoom. Layout and the shaping of React Flow's input are pure,
  separately tested functions, so swapping the layout engine is one function.
- The viewer's state is one reducer, with selection by query id rather than by
  position in a list, and each action resetting what it should in one place.
- The viewer draws plan nodes in relational-algebra notation — σ selection,
  π projection, χ map, ⋈ join, ⋉ semi/anti join, γ aggregation, τ sort, δ
  distinct, ⊎ union — and names scans by the relation they read. Engine
  plumbing and sinks are drawn muted, as not being operations on your data.
  Each symbol's tooltip names the operator and polars' own kind.
- The viewer reads each node's role from the profile and keeps a fallback
  table, tested kind-for-kind against the Python dialect, for files written
  before roles existed. Its vocabulary and counter list each live in one typed
  module; the physical plan's group-by keys, which were never labelled, now are.
- polars' plan property names are read in one place too. The dialect extracts
  what attributes and diagnostics need — scan source, predicates and columns,
  join type and keys, sort columns, group keys — into typed facets on each
  node, reconciling where the IR and the physical plan disagree (a predicate
  list against one string, `keys` against `key_per_input`). Downstream code no
  longer reads raw properties.
- polars' node vocabulary is translated in one place. Every plan node now
  carries a `role` — selection, projection, join, aggregation and so on, in
  relational-algebra terms — assigned by the adapter's dialect, and nothing
  downstream compares polars kind names. A renamed operator is a one-line
  dialect change; before, it touched three modules and failed no check.
- The per-node counter list is defined once, by `NodeMetrics`; decoding, model
  construction and the profile document derive from it instead of each keeping
  a copy.
- The model and exporters no longer import polars or the package root: the
  polars version travels on `Query`, `CallSite` is a model type, and the
  version lives in `_version.py`. A test enforces the dependency direction.
- The dialect knows the node kinds ordinary operations produce: `Cache` and
  `Zip` (engine), `AsOfJoin` and `RangeJoin` (theta joins), `OrderedUnion`, and
  `HConcat`, `Shift`, `ColumnarFunction`, `GatherEvery` and `Interpolate`
  (functions). A live contract test runs some thirty common operations and
  fails on any kind without a role, so the nightly canary sees a renamed or new
  operator across that whole surface rather than one fixture query.
- A plan node kind the dialect does not recognise is logged once at runtime and
  fails the golden and live contract tests, instead of silently emptying every
  attribute and diagnostic that depended on it.

### Fixed
- `polars.engine` named `streaming` for every query. Eager operations and
  queries collected with `engine="in-memory"` now say `in-memory`; a query
  that fails before planning has no engine on its span and `unknown` on its
  metrics.
- Long expressions in the viewer's details rail are set one method call per
  line, as they would be written, and a line still too wide scrolls rather than
  wrapping mid-token. An aggregation used to break inside its alias's string.
- The viewer's drop zone opens the file picker when clicked; only the header
  button did. The setup snippet beside it is complete — it never imported
  `polars_telemetry` — and highlighted again, with the same highlighter as the
  expressions in the details rail. A long line in it scrolls rather than
  pushing the empty state wider than its column.
- The viewer shows why a query failed. `failed` was written to every profile
  and never displayed, so a query that failed before planning looked like an
  empty plan.
- `redact_literals` covers exporters an application writes. Only the bundled
  exporters redacted, so a custom exporter installed with
  `Config(redact_literals=True)` received every literal. Redaction is now a
  transform on the whole query, applied before delivery to each exporter and
  session that asked for it — and if it fails, that receiver gets nothing
  rather than the unredacted query.
- The viewer shows a sink's IO counters when it only writes; the check for
  whether to show the IO group ignored bytes sent.
- Profiles record the polars version that ran the query again. A refactor in
  this release dropped it, so every profile said `unknown`; the test that
  should have caught it only checked that the field was present.
- `include_plan` JSON carries `largest_morsel_out`; the sent-side largest
  morsel was the one counter it left out.
- An IR plan polars has reshaped now costs only the IR. One shared guard
  dropped the node counters with it, and each query counted toward the
  failure threshold, so after five queries telemetry switched off entirely —
  of eight queries, four were exported, none with counters. Each payload is now
  decoded on its own, a payload that is not in the expected shape is logged
  once rather than counted, and the capability probe checks the IR as well as
  the physical plan.
- `profile()` honours `redact_literals`. `session.profiles()` and
  `session.write()` handed out plan literals even inside
  `profile(Config(redact_literals=True))`, or under an installed config that
  asked for redaction. Profile redaction now has one definition, used by both
  the file exporter and sessions.
- `polars.node.poll_time`, `polars.node.state_update_time` and
  `polars.node.max_state_update_time` are recorded. They were registered and
  documented but no code path ever recorded them.
- The viewer rejects a malformed profile at import instead of storing it and
  then throwing from render — which blanked the page permanently, since the bad
  session was already in browser storage and the control to clear it was inside
  the component that crashed. An error boundary offers a way back regardless.
- The viewer honours the profile schema version instead of prefix-matching it,
  so a file from a newer release says so rather than loading and blanking.
- `io_total_bytes_sent` is shown, and `projection_efficiency` and
  `has_table_statistics` render as chips. All three were written by the
  exporter and silently never displayed.
- Documentation corrected against the code: eight metric units were wrong
  (`rows` for `{row}`, `bytes` for `By`, and so on, which decides the series
  name an OTLP-to-Prometheus translator produces), `call_site` was missing from
  both option tables, and the install page stated a polars floor with no
  ceiling. Instrument units and `Config` options are now test-enforced, and
  mkdocs validates anchors so a renamed heading fails the build.
- `polars.projection_efficiency` always reported nothing. The two halves of the
  ratio live on different plans — the physical scan says how many columns were
  read, the IR scan how many the file holds — and only one was read, so the
  diagnostic could never fire.
- `polars.scan.columns` reported the width of the file rather than the number of
  columns read, which is the inverse of the signal it names. On a two-column
  projection of an eight-column parquet it said 8.
- Plan-derived diagnostics — predicate pushdown, row-group skipping, table
  statistics and projection — are no longer skipped for nodes without counters,
  so they survive `Config(node_metrics=False)`.
- A counter polars *adds* no longer disables node metrics. An unmodelled field
  was treated as a contract break, so the next polars release to add one would
  have degraded every user to query-spans-only on a single startup warning.
  Additions are now reported and ignored; only missing or retyped fields
  degrade.
- A query that fails before planning — a missing column, most commonly — now
  produces a span. The clock started in `on_query_planned`, which polars never
  calls for that class of failure, so the whole query went unreported. Losing
  the plan no longer loses the span either.
- `Query.failed` is the failure text polars passed, not a `repr` of the whole
  callback argument tuple, and it is redacted with everything else when
  `redact_literals` is set. The message quotes the offending values, so it
  carried user data past redaction on both the span and the profile.
- Call-site attribution skipped the package's parent directory, which resolves
  to `site-packages` in an installed wheel — so a query issued from inside any
  installed library was misattributed. Only the two package directories are
  skipped now, matched as directories rather than string prefixes.

## [0.1.1] - 2026-10-03

### Fixed
- Eager `DataFrame` operations no longer disable telemetry. polars runs them
  off the streaming engine and passes a nil physical plan, which was counted as
  a decode failure; five eager operations exhausted the error budget and
  disarmed the observer for the rest of the process, silently leaving every
  later lazy query uninstrumented. A nil physical plan is now the eager path:
  the query span is built from the IR, node counters are skipped because there
  is no `phys_node_key` to attribute them to, and nothing is counted as an
  error.

## [0.1.0] - 2026-10-03

### Added
- Repository scaffold: packaging, tooling, Docker development stack and CI.
- MessagePack decoding for the IR plan, physical plan and metrics payloads,
  with contract checks that describe how a payload departs from the known shape.
- Failure isolation: instrumentation errors are counted, logged once each, and
  disarm the hook past a threshold. Queries are never affected.
- Fixture capture tool and captured payloads for polars 1.44.2.
- Contract tests (golden and live) and a degradation suite covering renamed,
  added and retyped fields, corrupt payloads and callback arity changes.
- `install()` / `uninstall()`: binds the observer factory, enables monitoring,
  probes the installed polars and degrades to query spans only when the plan or
  metrics payloads are not as expected. Delegates to polars-cloud when present.
- Per-node counters read once when the query ends, with an adaptive settle on
  the closing snapshot rather than a fixed delay.
- OpenTelemetry exporter emitting one query span with plan-derived attributes,
  plus bounded-dimension metrics per node kind.
- User-facing attributes are read from the IR plan, which keeps the query's own
  column names; the physical plan rewrites group-by keys and aggregations to
  `_POLARS_TMP_N`.
- Overhead budget enforced in CI, measured by interleaving instrumented and
  uninstrumented runs so machine drift cancels.
- Documentation site (MkDocs Material), built with `--strict` in CI, with a
  test asserting the attribute reference documents every declared attribute.
- `polars.plan.fingerprint`: a hash of the plan *shape*, stable across
  parameter values and bounded by the application's code paths, so it is safe
  as a metric dimension where a query id is not.
- Derived diagnostics on the span: parallel efficiency, filter selectivity,
  join amplification, projection efficiency, morsel skew, predicate pushdown,
  row-group skipping and table statistics.
- `polars.metrics.complete`: false when the closing snapshot caught unfinished
  nodes, meaning the counters are a floor rather than a total.
- Every per-node field polars reports is exported, as 15 node instruments
  covering rows, morsels, polls, work-stealing, poll latency, state updates,
  and IO time and bytes. `largest_morsel` and `io_bytes` carry a `direction`
  dimension rather than one instrument per direction; stolen polls are exported
  as a ratio of total polls, and the per-node completion flag rides on the
  span as `polars.metrics.complete`.
- `Config(include_plan=True)` attaches the full plan and its counters to the
  span as JSON. Off by default.
- `FileExporter`: writes one self-contained profile per query to a JSON Lines
  session file, bounded by size with one retained generation. Carries both
  plans with node properties, all 19 counters per node, the diagnostics, the
  fingerprint, and the trace context when a span is active.
- A client-side profile viewer shipped with the docs site. Loads a session file
  in the browser with no upload, groups runs by fingerprint, renders both plans
  with per-node counters, and compares two runs of the same shape.
- `ConsoleExporter`: human-readable output for debugging without OTel wiring.

### Notes
- There are no per-node spans. polars exposes no per-node timestamps, so a node
  interval can only be sampled; sampling measured at 5-15% of query wall time
  and collapsed most nodes onto identical windows. The same counters read once
  at query end are exact and cost nothing measurable.

[0.5.1]: https://github.com/jan-krueger/polars-telemetry/releases/tag/v0.5.1
[0.5.0]: https://github.com/jan-krueger/polars-telemetry/releases/tag/v0.5.0
[0.4.0]: https://github.com/jan-krueger/polars-telemetry/releases/tag/v0.4.0
[0.3.1]: https://github.com/jan-krueger/polars-telemetry/releases/tag/v0.3.1
[0.3.0]: https://github.com/jan-krueger/polars-telemetry/releases/tag/v0.3.0
[0.2.0]: https://github.com/jan-krueger/polars-telemetry/releases/tag/v0.2.0
[0.1.1]: https://github.com/jan-krueger/polars-telemetry/releases/tag/v0.1.1
[0.1.0]: https://github.com/jan-krueger/polars-telemetry/releases/tag/v0.1.0
