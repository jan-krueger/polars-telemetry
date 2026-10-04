/** The findings polars-telemetry wrote into a profile, arranged for the plan view. */

import type { Finding, FindingLevel, Measure, Profile } from "../model/profile";

/** Problem findings per physical node, most important first. */
export function byNode(profile: Profile | null): Map<number, Finding[]> {
  const found = new Map<number, Finding[]>();
  for (const finding of profile?.insights ?? []) {
    found.set(finding.node_id, [...(found.get(finding.node_id) ?? []), finding]);
  }
  return found;
}

/** The level a node's badge shows: a warning over information; applied facts get none. */
export function badge(findings: Finding[] | undefined): Exclude<FindingLevel, "applied"> | null {
  if (findings?.some((f) => f.level === "warn")) return "warn";
  if (findings?.some((f) => f.level === "info")) return "info";
  return null;
}

/** Nodes with a warning, in the order the findings rank them. */
export function warned(profile: Profile | null): number[] {
  const ids = (profile?.insights ?? []).filter((f) => f.level === "warn").map((f) => f.node_id);
  return [...new Set(ids)];
}

/** How a finding's impact reads: "46% of CPU" or "59% of wall time". */
export function impact(finding: Finding): string {
  const wall = finding.blocked_share > finding.cpu_share;
  const share = wall ? finding.blocked_share : finding.cpu_share;
  const percent = share * 100;
  const text = percent >= 10 ? percent.toFixed(0) : percent >= 0.1 ? percent.toFixed(1) : "<0.1";
  return `${text}% of ${wall ? "wall time" : "CPU"}`;
}

const DOCS = "https://jan-krueger.github.io/polars-telemetry/insights/";

export const ruleDocs = (rule: string): string => `${DOCS}#${rule}`;

const significant = (v: number, digits: number): string => String(Number(v.toPrecision(digits)));

/** A measured value as the CLI prints it: 12.4M rows, 1.1 min, 0.0016%, 41.3x. */
export function measured({ value, unit }: Measure): string {
  if (unit === "share") {
    const percent = value * 100;
    if (percent === 0) return "0%";
    return percent >= 9.95 ? `${percent.toFixed(0)}%` : `${significant(percent, 2)}%`;
  }
  if (unit === "ratio") return `${significant(value, 3)}x`;
  if (unit === "ms") {
    if (value < 1_000) return `${value.toFixed(0)} ms`;
    if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
    return `${(value / 60_000).toFixed(1)} min`;
  }
  if (Math.abs(value) < 100_000) return Math.round(value).toLocaleString("en-US");
  for (const [divisor, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (Math.abs(value) >= divisor) return `${significant(value / divisor, 3)}${suffix}`;
  }
  return String(value);
}
