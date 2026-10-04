/** The findings polars-telemetry wrote into a profile, arranged for the plan view. */

import type { Finding, FindingLevel, Profile } from "../model/profile";

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
