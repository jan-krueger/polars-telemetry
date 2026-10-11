import { span } from "../lib/format";
import type { QueryOverview } from "./api";

const RULES: Record<string, string> = {
  in_memory_fallback: "In-memory fallback",
  exploding_join: "Join multiplies rows",
  cross_join: "Cross join",
  repeated_string_scan: "Repeated string scan",
  redundant_aggregation: "Deduplication removes nothing",
  python_udf: "Python function",
  datetime_format_inferred: "Date format guessed",
  repeated_subplan: "Repeated subplan",
  repeated_plugin_call: "Repeated plugin call",
};

/** A warning rule's plain name. */
export const ruleName = (rule: string): string => RULES[rule] ?? rule.replaceAll("_", " ");

/** 6.0× slower, 2.1× faster */
export function times(ratio: number): string {
  const r = ratio >= 1 ? ratio : 1 / ratio;
  return `${r < 10 ? r.toFixed(1) : Math.round(r)}× ${ratio >= 1 ? "slower" : "faster"}`;
}

export type Kind = "slower" | "failing" | "warning" | "faster";

/** What changed about a query in its last day, most pressing first. */
export function kinds(q: QueryOverview): Kind[] {
  const out: Kind[] = [];
  if (q.verdict === "slower") out.push("slower");
  if (q.recent_failed > 0) out.push("failing");
  if (q.new_rules.length) out.push("warning");
  if (q.verdict === "faster") out.push("faster");
  return out;
}

export const needsLook = (q: QueryOverview): boolean => kinds(q).some((k) => k !== "faster");

/** Orders queries with something to look at first, then by time spent. */
export function byAttention(a: QueryOverview, b: QueryOverview): number {
  const weight = (q: QueryOverview) => (q.verdict === "slower" ? 4 : 0) + (q.recent_failed ? 4 : 0) + (q.new_rules.length ? 2 : 0) + (q.verdict === "faster" ? 1 : 0);
  return weight(b) - weight(a) || b.total_wall_ms - a.total_wall_ms;
}

const ns = (v: number) => new Date(Math.round(v / 1e6));

/** today 09:05, yesterday 14:02, Fri 9 Oct 14:02 */
export function when(at: number, now = Date.now()): string {
  const date = ns(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/** just now, 14 min ago, 3 h ago, 2 d ago */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at / 1e6) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** 24 runs a day, 6 runs a week */
export function cadence(runs: number, days: number): string {
  const perDay = runs / Math.max(days, 1);
  if (perDay >= 1.5) return `${Math.round(perDay)} runs a day`;
  const perWeek = perDay * 7;
  return perWeek >= 1.5 ? `${Math.round(perWeek)} runs a week` : runs === 1 ? "1 run" : `${runs} runs`;
}

/** One sentence on why a query shows up as `kind`. */
export function reason(q: QueryOverview, kind: Kind, now = Date.now()): string {
  const usual = q.usual_wall_ms === null ? null : span(q.usual_wall_ms);
  const recent = q.recent_wall_ms === null ? null : span(q.recent_wall_ms);
  const plan = q.plan_changed_unix_ns === null ? null : when(q.plan_changed_unix_ns, now);
  switch (kind) {
    case "slower":
    case "faster": {
      const head = `${recent}, usually ${usual} (${times(q.ratio ?? 1)}).`;
      if (!plan) return `${head} Same plan.`;
      return `${head} Plan changed ${plan}.${q.new_rules.length ? ` New: ${q.new_rules.map(ruleName).join(", ")}.` : ""}`;
    }
    case "failing":
      return `${q.recent_failed} of ${q.recent_runs} runs failed${q.failed_before ? `, ${q.failed_before} in the two weeks before` : ", none before"}.`;
    case "warning": {
      const since = q.new_rules_since_unix_ns === null ? "" : ` since ${when(q.new_rules_since_unix_ns, now)}`;
      return `${q.new_rules.map(ruleName).join(", ")}${since}.${plan ? ` Plan changed ${plan}.` : ""}${!q.verdict && recent && usual ? ` ${recent}, usually ${usual}.` : ""}`;
    }
  }
}
