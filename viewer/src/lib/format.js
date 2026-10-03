import { relationName, roleOf } from "./polars";

export const num = (v, d = 0) =>
  (v ?? 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const ms = (v) =>
  v >= 10 ? num(v, 1) + " ms" : v >= 0.1 ? num(v, 2) + " ms" : num(v * 1000, 0) + " µs";
export const rows = (v) =>
  v >= 1e6 ? num(v / 1e6, 2) + "M" : v >= 1e3 ? num(v / 1e3, 1) + "k" : num(v, 0);
export const bytes = (b) =>
  b >= 1048576 ? num(b / 1048576, 1) + " MiB" : num(b / 1024, 1) + " KiB";

/** A name for a query without a label: the first table it reads. */
export function shapeName(p) {
  const scan = p.plan.logical.find((n) => roleOf(n) === "scan");
  return (scan && relationName(scan.properties ?? {})) || `${p.plan.physical.length} nodes`;
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
  if (d.parallel_efficiency !== undefined)
    push("parallel_efficiency", "Parallel efficiency", num(d.parallel_efficiency * 100, 0), "%",
      d.parallel_efficiency >= 0.7 ? "good" : d.parallel_efficiency >= 0.4 ? "warn" : "crit",
      `${num(d.parallel_efficiency * (d.cpu_count || 1), 1)} of ${d.cpu_count} cores`);
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
