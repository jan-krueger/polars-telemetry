# Profile viewer

The viewer reads the `.jsonl` files the [JSONL exporter](exporters/jsonl.md)
and `profile()` write, and shows both plans of each query with every counter.

[Open the viewer](viewer/index.html), then drag one or more `.jsonl` files onto
the page, or use **Open .jsonl**.

**Nothing is uploaded.** The page makes no network requests; files are read in
your browser.

![Both plans, per-node counters and diagnostics for one query](assets/viewer.png)

## Try it

The repository's
[`examples/`](https://github.com/jan-krueger/polars-telemetry/tree/main/examples)
holds two sessions: the 22 TPC-H queries at scale factor 1 and 10, three runs
each, labelled `tpch/q1` to `tpch/q22`.

## Sessions

Each file you open becomes a session, kept in your browser so it is still there
after a reload. The left sidebar lists sessions with when their queries ran;
the download button saves one as a `.jsonl` again, and `×` removes it.

Where the browser keeps nothing, such as in a private window or with the page
opened from disk, the viewer works for the current page only and says so.

## Finding a query

The session overview lists each query shape, the runs of one query, with its
total and mean times. Click a column header to sort by it.

Queries are titled by their [label](labels.md), or else by the first table they
read. The search box matches labels, file names, tables and fingerprints.

The address bar follows what is on screen, so reload and the back button work
as expected. A link only opens in the browser where that session was imported.

## Reading a plan

Each query shows the logical plan on the left and the physical plan on the
right. Drag to pan, scroll to zoom; the minimap shows where you are.

- **Logical plan**: the plan as written, with your own column names.
- **Physical plan**: what ran. Nodes are shaded by their share of CPU time,
  edges are labelled with rows, and a dot shows whether each node finished.
  polars renames grouped columns to `_POLARS_TMP_N` here.

Click a node for its properties and every counter in the right sidebar. Each
counter's `?` explains what it measures. Long expressions are set one method
call or condition per line.

## Comparing runs

When a query ran more than once, pick another run under **compare with…** and
every figure gains its change in percent.
