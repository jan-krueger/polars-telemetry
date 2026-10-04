import { relationName, roleOf } from "./polars";

export const num = (v, d = 0) =>
  (v ?? 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const ms = (v) =>
  v >= 10 ? num(v, 1) + " ms" : v >= 0.1 ? num(v, 2) + " ms" : num(v * 1000, 0) + " µs";
export const bytes = (b) =>
  b >= 1048576 ? num(b / 1048576, 1) + " MiB" : num(b / 1024, 1) + " KiB";

/** The first table a query reads, if it reads a named one. */
export function tableName(p) {
  const scan = p.plan.logical.find((n) => roleOf(n) === "scan");
  return (scan && relationName(scan.properties ?? {})) || null;
}

/** A name for a query without a label: the first table it reads. */
export const shapeName = (p) => tableName(p) ?? `${p.plan.physical.length} nodes`;

/** A duration at the scale a reader thinks in: 40 µs, 5.3 ms, 88.9 s, 456 s, 13.0 min. */
export function span(v) {
  if (v < 1) return `${num(v * 1_000, 0)} µs`;
  if (v < 1_000) return `${num(v, v < 10 ? 1 : 0)} ms`;
  if (v < 600_000) return `${num(v / 1_000, v < 100_000 ? 1 : 0)} s`;
  return `${num(v / 60_000, 1)} min`;
}

/** A count at the scale a reader thinks in: 940, 12,345, 301K, 57.7M. */
export function compact(v) {
  if (Math.abs(v) < 100_000) return num(v);
  for (const [divisor, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]])
    if (Math.abs(v) >= divisor) return `${Number((v / divisor).toPrecision(3))}${suffix}`;
  return num(v);
}

/** How many of the threads polars had were busy on average, and how that reads. */
export function busy(p) {
  if (!(p.wall_ms > 0) || !(p.cpu_ms > 0)) return null;
  const threads = p.cpu_ms / p.wall_ms;
  const of = p.diagnostics?.cpu_count ?? null;
  const share = of ? Math.min(1, threads / of) : null;
  const verdict = share == null ? "info" : share >= 0.7 ? "good" : share >= 0.4 ? "warn" : "crit";
  return { threads, of, share, verdict };
}

const JOINS = new Set(["join", "theta_join", "cross_join", "semi_anti_join"]);

/** The largest join's rows out over its larger input, as the exporter computes it. */
export function joinGrowth(plan) {
  const byId = new Map(plan.map((n) => [n.id, n]));
  const consumers = new Map();
  for (const n of plan) for (const i of n.inputs) consumers.set(i, (consumers.get(i) ?? 0) + 1);
  let growth;
  for (const n of plan) {
    const out = n.metrics?.rows_sent;
    if (!JOINS.has(roleOf(n)) || typeof out !== "number") continue;
    const larger = Math.max(0, ...n.inputs.map((i) => {
      const sent = byId.get(i)?.metrics?.rows_sent;
      return typeof sent === "number" ? sent / (consumers.get(i) ?? 1) : 0;
    }));
    if (larger) growth = Math.max(growth ?? 0, out / larger);
  }
  return growth;
}

/** Thresholds turn a measurement into a verdict. */
export function diagnostics(p) {
  const d = p.diagnostics || {}, out = [];
  const push = (k, t, v, u, s, n) => out.push({ k, t, v, u, s, n });
  const growth = typeof d.join_growth === "number" ? d.join_growth : joinGrowth(p.plan?.physical ?? []);
  if (growth !== undefined)
    push("join_growth", "Join growth", num(growth, 2), "×",
      growth <= 2 ? "good" : growth <= 10 ? "warn" : "crit",
      growth <= 2 ? "no row explosion" : "more rows than either input");
  if (d.filter_selectivity !== undefined)
    push("filter_selectivity", "Filter selectivity", num(d.filter_selectivity * 100, 1), "%",
      "info", `${num(d.filter_rows_dropped)} rows dropped`);
  if (d.morsel_skew !== undefined)
    push("morsel_skew", "Morsel skew", num(d.morsel_skew, 2), "×",
      d.morsel_skew <= 2 ? "good" : d.morsel_skew <= 4 ? "warn" : "crit",
      d.morsel_skew <= 2 ? "partitions even" : "largest morsel above the mean");
  if (d.projection_efficiency !== undefined)
    push("projection_efficiency", "Projection", num(d.projection_efficiency * 100, 0), "%",
      d.projection_efficiency <= 0.5 ? "good" : d.projection_efficiency < 1 ? "warn" : "info",
      d.projection_efficiency >= 1 ? "every column read" : "unread columns never decoded");
  if (d.predicate_pushed !== undefined)
    push("predicate_pushed", "Predicate pushdown", d.predicate_pushed ? "yes" : "no", "",
      d.predicate_pushed ? "good" : "warn",
      d.predicate_pushed ? "filter inside the scan" : "every row read");
  if (d.has_table_statistics !== undefined)
    push("has_table_statistics", "Table statistics", d.has_table_statistics ? "yes" : "no", "",
      d.has_table_statistics ? "good" : "info",
      d.has_table_statistics ? "available for pruning" : "none to prune with");
  if (d.incomplete_nodes)
    push("done", "Counters incomplete", d.incomplete_nodes, " nodes", "warn",
      "figures are a floor, not a total");
  return out;
}

export const rows = compact;
