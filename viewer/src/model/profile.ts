/**
 * The viewer's own view of a profile.
 *
 * Components read only this. It keeps the document's field names — renaming
 * them would buy nothing — but it is produced by a reader per schema version
 * (`read.ts`), so a future `profile@2` that restructures the document is a new
 * reader, not a change to every component.
 */

import type { Role } from "../lib/polars";

export type Metrics = Record<string, number | boolean> & { done?: boolean };

/** A figure a node reports about itself (polars 2 and later), named by polars. */
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
  /** Always set: from the profile when it says, derived otherwise. */
  role: Role;
  /** The short parameter shown under the node. */
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

/** One insight about one node, as polars-telemetry wrote it (insights@1). */
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
  /** Set with polars_telemetry.label(); nested labels joined with "/". */
  label: string | null;
  /** What was masked before export, e.g. ["strings", "numbers"]; null if nothing. */
  redacted: string[] | null;
  schema: string;
  polars_version: string;
  fingerprint: string;
  started_unix_ns: number;
  wall_ms: number;
  /** Start to execution: polars optimising and lowering the plan; null before 0.6. */
  planning_ms: number | null;
  /** polars-telemetry's own work before execution, within wall time. */
  telemetry_ms: number | null;
  cpu_ms: number;
  result_rows: number | null;
  call_site: CallSite | null;
  failed: string | null;
  diagnostics: Record<string, unknown>;
  /** Most important first; null when the profile was written without insights. */
  insights: Finding[] | null;
  plan: { physical: PlanNode[]; logical: PlanNode[] };
}

/** What the session list knows without reading a session's profiles. */
export interface SessionInfo {
  id: string;
  name: string;
  importedAt: number;
  /** When it was last opened in this browser; null until it is. */
  openedAt: number | null;
  bytes: number;
  count: number;
  /** Its profiles' query ids, so a file opened twice is recognised unread. */
  runIds: string[];
  /** When its first and last queries started, in ns; null if none recorded it. */
  ran: [number, number] | null;
}

export interface Session extends SessionInfo {
  /** Null until read: a session is listed at once and read when opened. */
  profiles: Profile[] | null;
  /** The documents as written, for downloading the session again. */
  raw: unknown[] | null;
  /** For a session opened from a link and not kept: that link's fragment. */
  shared?: string;
}
