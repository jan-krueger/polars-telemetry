import type { CustomMetric, PlanNode, Profile } from "../model/profile";
import { relationName, roleOf } from "./polars";

const formats = new Map<number, Intl.NumberFormat>();

export function num(v: number | null | undefined, d = 0): string {
  let format = formats.get(d);
  if (!format) formats.set(d, (format = new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })));
  return format.format(v ?? 0);
}
export const ms = (v: number): string =>
  v >= 10 ? num(v, 1) + " ms" : v >= 0.1 ? num(v, 2) + " ms" : num(v * 1000, 0) + " µs";
export const bytes = (b: number): string =>
  b >= 1048576 ? num(b / 1048576, 1) + " MiB" : num(b / 1024, 1) + " KiB";

export function inputs(p: Profile): string[] {
  const names = p.plan.logical.filter((n) => roleOf(n) === "scan").map((n) => relationName(n.properties ?? {}));
  return [...new Set(names.filter(Boolean))];
}

export const shapeName = (p: Profile): string => inputs(p)[0] ?? `${p.plan.physical.length} nodes`;

/** 40 µs, 5.3 ms, 88.9 s, 456 s, 13.0 min */
export function span(v: number): string {
  if (v < 1) return `${num(v * 1_000, 0)} µs`;
  if (v < 1_000) return `${num(v, v < 10 ? 1 : 0)} ms`;
  if (v < 600_000) return `${num(v / 1_000, v < 100_000 ? 1 : 0)} s`;
  return `${num(v / 60_000, 1)} min`;
}

/** 940, 12,345, 301K, 57.7M */
export function compact(v: number): string {
  if (Math.abs(v) < 100_000) return num(v);
  for (const [divisor, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const)
    if (Math.abs(v) >= divisor) return `${Number((v / divisor).toPrecision(3))}${suffix}`;
  return num(v);
}

export type Verdict = "good" | "warn" | "crit" | "info";

export interface Busy {
  threads: number;
  of: number | null;
  share: number | null;
  verdict: Verdict;
}

export function busy(p: Profile): Busy | null {
  if (!(p.wall_ms > 0) || !(p.cpu_ms > 0)) return null;
  const threads = p.cpu_ms / p.wall_ms;
  const of = (p.diagnostics?.cpu_count as number | undefined) ?? null;
  const share = of ? Math.min(1, threads / of) : null;
  const verdict: Verdict = share == null ? "info" : share >= 0.7 ? "good" : share >= 0.4 ? "warn" : "crit";
  return { threads, of, share, verdict };
}

const JOINS = new Set(["join", "theta_join", "cross_join", "semi_anti_join"]);

/** Rows out over the larger input; a shared input counts once per consumer. */
export function nodeGrowth(node: PlanNode, plan: PlanNode[]): number | undefined {
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

/** Must match the exporter. */
export function joinGrowth(plan: PlanNode[]): number | undefined {
  const all = plan.map((n) => nodeGrowth(n, plan)).filter((g): g is number => g !== undefined);
  return all.length ? Math.max(...all) : undefined;
}

export interface Fact {
  key: string;
  label: string;
  value: string;
}

export function nodeFacts(node: PlanNode, plan: PlanNode[]): Fact[] {
  const m = (node.metrics ?? {}) as Record<string, number>, out: Fact[] = [];
  if (roleOf(node) === "selection" && m.rows_received) {
    out.push({ key: "rows_kept", label: "Rows kept", value: `${num((m.rows_sent! / m.rows_received) * 100, 1)}%` });
  }
  const growth = nodeGrowth(node, plan);
  if (growth !== undefined) {
    out.push({ key: "join_growth", label: "Growth", value: `${num(growth, 2)}×` });
  }
  if (m.morsels_received && m.rows_received) {
    const skew = m.largest_morsel_received! / (m.rows_received / m.morsels_received);
    out.push({ key: "morsel_skew", label: "Morsel skew", value: `${num(skew, 2)}×` });
  }
  return out;
}

export const rows = compact;

/** `group_by.actual_groups` → "Actual groups" */
export function customLabel(key: string): string {
  const name = key.split(".").pop()!.replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export const customValue = ({ unit, value }: CustomMetric): string =>
  value == null ? "—" : unit === "By" ? bytes(value) : unit === "ns" ? ms(value / 1e6) : num(value);
