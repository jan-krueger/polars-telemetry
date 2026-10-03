export const num = (v, d = 0) =>
  (v ?? 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const ms = (v) =>
  v >= 10 ? num(v, 1) + " ms" : v >= 0.1 ? num(v, 2) + " ms" : num(v * 1000, 0) + " µs";
export const rows = (v) =>
  v >= 1e6 ? num(v / 1e6, 2) + "M" : v >= 1e3 ? num(v / 1e3, 1) + "k" : num(v, 0);
export const bytes = (b) =>
  b >= 1048576 ? num(b / 1048576, 1) + " MB" : num(b / 1024, 0) + " KB";
export const cpuMs = (n) => (n.metrics?.total_time_ns ?? 0) / 1e6;

/** A readable name for a query shape, from the plan the user actually wrote. */
export function shapeName(p) {
  const l = p.plan.logical;
  const joins = l.filter((n) => n.kind === "Join").length;
  const keys = l.find((n) => n.kind === "GroupBy")?.properties?.keys || [];
  const src = l.find((n) => n.kind === "Scan")?.properties?.first_source;
  const bits = [];
  if (src) bits.push(String(src).split("/").pop());
  if (joins) bits.push(`${joins} join${joins > 1 ? "s" : ""}`);
  if (keys.length) bits.push("by " + keys.map((x) => String(x).slice(4, -1).replace(/"/g, "")).join(", "));
  return bits.join(" · ") || `${p.plan.physical.length} nodes`;
}

/** Thresholds turn a measurement into a verdict. */
export function diagnostics(p) {
  const d = p.diagnostics || {}, out = [];
  const push = (k, t, v, u, s, n) => out.push({ k, t, v, u, s, n });
  if (d.parallel_efficiency !== undefined)
    push("parallel_efficiency", "Parallel efficiency", num(d.parallel_efficiency * 100, 0), "%",
      d.parallel_efficiency >= 0.7 ? "good" : d.parallel_efficiency >= 0.4 ? "warn" : "crit",
      `${num(d.parallel_efficiency * (d.cpu_count || 1), 1)} of ${d.cpu_count} cores`);
  if (d.join_amplification !== undefined)
    push("join_amplification", "Join amplification", num(d.join_amplification, 2), "×",
      d.join_amplification <= 1.5 ? "good" : d.join_amplification <= 4 ? "warn" : "crit",
      d.join_amplification <= 1.5 ? "no row explosion" : "rows fanning out");
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

/** A profile line per JSON object; a truncated last line is expected. */
export const SCHEMA_PREFIX = "polars-telemetry/profile@";
export const SUPPORTED_SCHEMAS = new Set([1]);

/** A profile only renders if these hold; a bad one must be rejected at import
 *  rather than persisted and then thrown from render. */
export function profileProblem(d) {
  if (typeof d !== "object" || d === null) return "not an object";
  const schema = String(d.schema || "");
  if (!schema.startsWith(SCHEMA_PREFIX)) return "not a polars-telemetry profile";
  const version = Number(schema.slice(SCHEMA_PREFIX.length));
  if (!SUPPORTED_SCHEMAS.has(version)) return `schema ${schema} needs a newer viewer`;
  const plan = d.plan;
  if (typeof plan !== "object" || plan === null) return "no plan";
  for (const side of ["physical", "logical"]) {
    const nodes = plan[side];
    if (!Array.isArray(nodes)) return `plan.${side} is not an array`;
    for (const n of nodes) {
      if (typeof n !== "object" || n === null) return `plan.${side} has a non-node entry`;
      if (!Number.isFinite(n.id)) return `plan.${side} has a node without an id`;
      if (!Array.isArray(n.inputs)) return `plan.${side} node ${n.id} has no inputs`;
    }
  }
  return null;
}

/** Profiles, plus a reason for every line that is not one. */
export function parseJsonl(text) {
  const profiles = [];
  const rejected = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let d;
    try { d = JSON.parse(t); } catch { rejected.push("not valid JSON"); continue; }
    const problem = profileProblem(d);
    if (problem) rejected.push(problem);
    else profiles.push(d);
  }
  profiles.rejected = rejected;
  return profiles;
}
