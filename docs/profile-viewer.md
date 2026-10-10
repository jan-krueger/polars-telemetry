# Profile viewer

The viewer reads the `.jsonl` files the [JSONL exporter](exporters/jsonl.md)
and `profile()` write, and the recordings of the
[events exporter](exporters/events.md), gzip-compressed or not. It shows both
plans of each query with every counter.

[Open the viewer](viewer/index.html), then drag one or more files onto the page,
or use **Open .jsonl**.

**Nothing is uploaded.** Files are read in your browser. The page makes no
requests except to fetch an example from this site when you ask for one.

![Both plans of a TPC-H query, its figures, and a finding on the selected node](assets/viewer.png)

## Try it

The empty viewer offers one-click example sessions: the TPC-H queries at
scale factor 1 and 10, labelled `tpch/q1`, `tpch/q2` and so on. For a viewer
opened from disk, they are in the repository's
[`examples/`](https://github.com/jan-krueger/polars-telemetry/tree/main/examples).

## Sessions

Each opened file becomes a session, stored in your browser and kept across
reloads. Opening a file that is already stored switches to it instead of
storing it twice. Only the open session is read into memory, so many stored
sessions do not slow opening.

| Control | Does |
| --- | --- |
| Session name, top of the left sidebar | lists the most recently opened sessions |
| **All sessions**, in that menu, or the "sessions stored" count at the top | lists every session with its size and last-opened time; search, sort by name, size or date, select several to remove |
| Double-click a name, or F2 on it | renames the session |
| Download button | saves the session as a `.jsonl` again |

Where the browser keeps nothing, such as in a private window or with the page
opened from disk, the viewer works for the current page only and says so.

## Finding a query

The session overview lists each query shape (the runs of one query) with its
total and mean times, numbered in the order the session first ran them. The
overview and the query list follow that order until you click a column header
to sort by another.

Queries are titled by their [label](labels.md), or else by the first table they
read. Search matches labels, file names, tables and fingerprints.

The address bar follows the screen, so reload and back work. That URL opens
only in the browser where the session was imported.

## Reading a plan

Above the plans, a query shows:

- wall time;
- average busy threads (node CPU ÷ wall time, as a bar against Polars' thread
  count).

Hover the figures for exact times, planning and CPU. The ⓘ beside the query's
name holds the tables it reads, its shape fingerprint, start time, rows
returned, Polars version and the line of code that ran it.

A selected node's metrics open with derived figures: the share of rows a filter
kept, a join's rows out against its larger input, and how uneven its batches
were.

The logical plan is on the left, the physical plan on the right. Drag to pan,
scroll to zoom; the minimap shows where you are.

- **Logical plan**: the plan as written, with your own column names.
- **Physical plan**: what ran. Nodes are shaded by their share of CPU time and
  edges are labelled with rows. Polars renames many keys to internal columns
  here; a node then gives their number, such as "by 2 keys", and the logical
  plan has their names.

Every node reads the same way:

| Where | What |
| --- | --- |
| First line | The operator, as Polars names it, and its kind when it has one: `EquiJoin · inner`, `MultiScan · parquet` |
| Second line | What it works on: the file, keys, columns or condition. Empty when there is nothing to add |
| Third line | Its share of CPU time and the time itself |
| Top right | Only what stands out: work pushed into a scan (a filter, a column selection, a row limit, skipped files), a sort that keeps some rows, a finding, a node that had not finished. Hover for the details |

Click a node for its properties and every counter in the right sidebar. Each
counter's `?` explains what it measures. Long expressions are set one method
call or condition per line.

The slider above the physical plan fades the cheapest nodes still lit, one
step at a time; the readout gives how many remain and their share of CPU time.
The setting carries over to the next query as that share, not as a node count.

## Replaying a recording

A query from an [events recording](exporters/events.md) can be replayed. The bar
above the plans shows how many threads the query kept busy over its run; drag
along it, or play it. Playback takes about twelve seconds whatever the query's
length; the speed button switches to real time. With the bar focused, ← and →
step from sample to sample and space plays or pauses.

While replaying:

- Nodes that have not started are faded, and edges carrying rows move, faster
  for more rows per second.
- The figures above the plans and a selected node's counters are those of that
  moment. Between two samples they are estimated and marked `≈`.
- Behind each of the node's counters, a line shows how it grew over the whole
  run, up to the moment shown.

A query that was still running when the recording ended opens with the counters
of its last sample and says so.

## Findings

Profiles written with [insights](insights.md), the default, carry what slows
each query down.

- The physical plan's header counts the warnings; its arrows step through them,
  zoomed in close enough to read.
- A node with a warning gets a badge and an outline that stays visible when a
  large plan is zoomed far out; the minimap marks it too.
- The node's details open with each finding: evidence, cost, a fix and a link
  to the rule.

Profiles written before 0.6.0, or with `Config(insights=False)`, show none;
`polars-telemetry insights FILE --write OUT` adds them.

## Sharing a query

**Share** offers three ways to pass a query on. **Copy link** puts the query on
screen into a link. The profiles travel after the `#`, which browsers never send to a server:
the recipient sees the same plans and nothing is uploaded.

A link opens as a session named after its query, marked *opened from a link,
not stored*. **Keep** stores it like an opened file, under whatever name you
gave it.

Anyone with the link can read everything in those profiles, and chat tools and
browser history keep it. For a profile not [masked](privacy.md) before export,
the viewer asks before copying, unless you ticked *Don't ask again in this
browser* there. For a link too long for chat tools, the viewer suggests sending
the session file instead.

**Copy as Markdown** copies it for a GitHub issue or pull request: its
figures, its findings with links to their rules, and the physical plan as a tree with each node's time, share of
CPU and rows. It carries the same literals, paths and labels a link does, so
the viewer asks the same question first. **Download session** saves the whole
session as the `.jsonl` it was opened from.

