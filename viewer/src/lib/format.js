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

/** A join's rows out over its larger input; an input feeding several consumers counts once per consumer. */
export function nodeGrowth(node, plan) {
  const out = node.metrics?.rows_sent;
  if (!JOINS.has(roleOf(node)) || typeof out !== "number") return undefined;
  const larger = Math.max(0, ...node.inputs.map((i) => {
    const input = plan.find((n) => n.id === i);
    const sent = input?.metrics?.rows_sent;
    const consumers = plan.filter((n) => n.inputs.includes(i)).length || 1;
    return typeof sent === "number" ? sent / consumers : 0;
  }));
  return larger ? out / larger : undefined;
}

/** The largest join's growth in a plan, as the exporter computes it. */
export function joinGrowth(plan) {
  const all = plan.map((n) => nodeGrowth(n, plan)).filter((g) => g !== undefined);
  return all.length ? Math.max(...all) : undefined;
}

/** What a node's counters say about it, for its kind: kept rows, growth, skew. */
export function nodeFacts(node, plan) {
  const m = node.metrics ?? {}, out = [];
  if (roleOf(node) === "selection" && m.rows_received) {
    out.push({ key: "filter_selectivity", label: "Rows kept", value: `${num((m.rows_sent / m.rows_received) * 100, 1)}%`,
               note: `${compact(m.rows_received - m.rows_sent)} dropped` });
  }
  const growth = nodeGrowth(node, plan);
  if (growth !== undefined) {
    out.push({ key: "join_growth", label: "Growth", value: `${num(growth, 2)}×`,
               note: growth <= 2 ? "no row explosion" : "more rows than its larger input" });
  }
  if (m.morsels_received && m.rows_received) {
    const skew = m.largest_morsel_received / (m.rows_received / m.morsels_received);
    out.push({ key: "morsel_skew", label: "Morsel skew", value: `${num(skew, 2)}×`,
               note: skew <= 2 ? "batches even" : "largest batch above the mean" });
  }
  return out;
}

export const rows = compact;

/** A node's own figure as a reader names it: `group_by.actual_groups` reads "Actual groups". */
export function customLabel(key) {
  const name = key.split(".").pop().replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A node's own figure in its unit. */
export const customValue = ({ unit, value }) =>
  value == null ? "—" : unit === "By" ? bytes(value) : unit === "ns" ? ms(value / 1e6) : num(value);
