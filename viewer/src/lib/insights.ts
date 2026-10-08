import type { Finding, FindingLevel, Measure, Profile } from "../model/profile";
import { compact } from "./format";

export function byNode(profile: Profile | null): Map<number, Finding[]> {
  const found = new Map<number, Finding[]>();
  for (const finding of profile?.insights ?? []) {
    found.set(finding.node_id, [...(found.get(finding.node_id) ?? []), finding]);
  }
  return found;
}

/** Applied findings get no badge. */
export function badge(findings: Finding[] | undefined): Exclude<FindingLevel, "applied"> | null {
  if (findings?.some((f) => f.level === "warn")) return "warn";
  if (findings?.some((f) => f.level === "info")) return "info";
  return null;
}

export function warned(profile: Profile | null): number[] {
  const ids = (profile?.insights ?? []).filter((f) => f.level === "warn").map((f) => f.node_id);
  return [...new Set(ids)];
}

/** "46% of CPU", "59% of wall time" */
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

/** As the CLI prints it. */
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
  return compact(value);
}
