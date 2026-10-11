import type { Profile } from "../model/profile";
import { readJsonl } from "../model/read";

export type Status = "running" | "finished" | "failed" | "unfinished";

export interface QuerySummary {
  query_id: string;
  stream_id: string;
  project: string;
  service: string | null;
  environment: string | null;
  host: string;
  label: string | null;
  fingerprint: string | null;
  status: Status;
  started_unix_ns: number;
  wall_ms: number | null;
  cpu_ms: number | null;
  result_rows: number | null;
  failed: string | null;
  warnings: number;
  rules: string[];
  recording: string | null;
}

export interface GroupSummary {
  key: string | null;
  runs: number;
  failed: number;
  last_started_unix_ns: number;
  total_wall_ms: number;
  rules: string[];
  recent_wall_ms: number[];
}

export interface Pulse {
  query_id: string;
  elapsed_ms: number;
  threads: number[];
  busiest: { id: number; kind: string; threads: number } | null;
  done: number;
  nodes: number;
}

export interface Count {
  value: string | null;
  runs: number;
}

export interface Facets {
  service: Count[];
  environment: Count[];
  host: Count[];
  status: Count[];
}

export type Verdict = "slower" | "faster";

export interface Day {
  runs: number;
  failed: number;
  median_wall_ms: number | null;
}

export interface QueryOverview {
  label: string | null;
  service: string | null;
  runs: number;
  failed: number;
  last_started_unix_ns: number;
  total_wall_ms: number;
  usual_wall_ms: number | null;
  usual_band_ms: [number, number] | null;
  recent_wall_ms: number | null;
  recent_runs: number;
  recent_failed: number;
  failed_before: number;
  first_recent_failure_unix_ns: number | null;
  verdict: Verdict | null;
  ratio: number | null;
  rules: string[];
  new_rules: string[];
  new_rules_since_unix_ns: number | null;
  plan_changed_unix_ns: number | null;
  bins: (number | null)[];
  days: Day[];
}

export interface Overview {
  now_unix_ns: number;
  since_unix_ns: number;
  days: number[];
  queries: QueryOverview[];
}

export interface Version {
  fingerprint: string | null;
  runs: number;
  failed: number;
  first_started_unix_ns: number;
  last_started_unix_ns: number;
  usual_wall_ms: number | null;
  rules: string[];
  latest_query_id: string;
}

export type Filter = Partial<Record<"label" | "fingerprint" | "service" | "environment" | "host" | "status", string>> & {
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  order?: "oldest";
};

export class NotFound extends Error {}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (response.status === 404) throw new NotFound(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

export const query = (id: string): Promise<QuerySummary> => json(`/api/queries/${encodeURIComponent(id)}`);

function search(filter: Filter, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  return params.toString();
}

export const queries = (filter: Filter): Promise<QuerySummary[]> => json(`/api/queries?${search(filter)}`);
export const groups = (filter: Filter, by: "label" | "fingerprint" = "label"): Promise<GroupSummary[]> =>
  json(`/api/groups?${search(filter, { by })}`);
export const facets = (filter: Filter): Promise<Facets> => json(`/api/facets?${search(filter)}`);
export const overview = (filter: Filter, days: number): Promise<Overview> =>
  json(`/api/overview?${search(filter, { days: String(days), utc_offset: String(-new Date().getTimezoneOffset()) })}`);
export const versions = (label: string, since?: number): Promise<Version[]> => json(`/api/versions?${search({ label, since })}`);

export async function recording(id: string): Promise<Profile | null> {
  const response = await fetch(`/api/queries/${encodeURIComponent(id)}/recording`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`recording ${id}: ${response.status}`);
  return readJsonl(await response.text()).profiles[0] ?? null;
}
