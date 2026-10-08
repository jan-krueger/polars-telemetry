// Built per schema version by read.ts; components read only this.

import type { Role } from "../lib/polars";

export type Metrics = Record<string, number | boolean> & { done?: boolean };

/** polars 2 and later. */
export interface CustomMetric {
  key: string;
  /** "1" a count, "By" bytes, "ns" a duration. */
  unit: string;
  /** Null when polars never set it. */
  value: number | null;
}

export interface PlanNode {
  id: number;
  kind: string;
  /** Derived when the profile predates it. */
  role: Role;
  label: string;
  inputs: number[];
  properties: Record<string, unknown>;
  metrics: Metrics | null;
  custom: CustomMetric[];
}

export interface CallSite {
  filepath: string;
  lineno: number;
  function: string;
}

export type FindingLevel = "warn" | "info" | "applied";

export type Unit = "rows" | "count" | "ms" | "share" | "ratio";

export interface Measure {
  name: string;
  value: number;
  unit: Unit;
}

export interface Finding {
  rule: string;
  kind: "problem" | "applied";
  level: FindingLevel;
  node_id: number;
  node_kind: string;
  cpu_share: number;
  blocked_share: number;
  title: string;
  fix: string;
  evidence: Measure[];
}

export interface Profile {
  query_id: string;
  /** Nested labels joined with "/". */
  label: string | null;
  /** What was masked before export, e.g. ["strings", "numbers"]; null if nothing. */
  redacted: string[] | null;
  schema: string;
  polars_version: string;
  fingerprint: string;
  started_unix_ns: number;
  wall_ms: number;
  /** Null before 0.6. */
  planning_ms: number | null;
  /** Included in wall_ms. */
  telemetry_ms: number | null;
  cpu_ms: number;
  result_rows: number | null;
  call_site: CallSite | null;
  failed: string | null;
  diagnostics: Record<string, unknown>;
  /** Most important first. */
  insights: Finding[] | null;
  plan: { physical: PlanNode[]; logical: PlanNode[] };
}

export interface SessionInfo {
  id: string;
  name: string;
  importedAt: number;
  openedAt: number | null;
  bytes: number;
  count: number;
  /** Recognises a file opened twice without reading it. */
  runIds: string[];
  /** First and last query start, in ns. */
  ran: [number, number] | null;
}

export interface Session extends SessionInfo {
  /** Null until opened. */
  profiles: Profile[] | null;
  raw: unknown[] | null;
  /** The link fragment of a session opened from a link and not kept. */
  shared?: string;
}
