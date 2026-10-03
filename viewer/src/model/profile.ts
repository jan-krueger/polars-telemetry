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
}

export interface CallSite {
  filepath: string;
  lineno: number;
  function: string;
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
  cpu_ms: number;
  result_rows: number | null;
  call_site: CallSite | null;
  failed: string | null;
  diagnostics: Record<string, unknown>;
  plan: { physical: PlanNode[]; logical: PlanNode[] };
}

export interface Session {
  id: string;
  name: string;
  importedAt: number;
  bytes: number;
  profiles: Profile[];
  /** The documents as written, for downloading the session again. */
  raw: unknown[];
}

/** What IndexedDB holds: the documents as written, normalised on every load. */
export interface StoredSession extends Omit<Session, "profiles" | "raw"> {
  profiles: unknown[];
}
