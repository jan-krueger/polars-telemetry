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
  recording: string | null;
}

export interface GroupSummary {
  key: string | null;
  runs: number;
  failed: number;
  last_started_unix_ns: number;
  total_wall_ms: number;
  usual_wall_ms: number | null;
  slow_wall_ms: number | null;
  shapes: number;
  warnings: number;
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

export type Filter = Partial<Record<"label" | "fingerprint" | "service" | "environment" | "host" | "status", string>> & { since?: number; limit?: number };

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

export async function recording(id: string): Promise<Profile | null> {
  const response = await fetch(`/api/queries/${encodeURIComponent(id)}/recording`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`recording ${id}: ${response.status}`);
  return readJsonl(await response.text()).profiles[0] ?? null;
}

export function usual(runs: QuerySummary[], except: string): { usually: number; slow: number } | null {
  const walls = runs
    .filter((run) => run.query_id !== except && run.status === "finished" && run.wall_ms !== null)
    .map((run) => run.wall_ms!)
    .sort((a, b) => a - b);
  if (!walls.length) return null;
  const at = (q: number) => walls[Math.min(walls.length - 1, Math.floor(q * (walls.length - 1)))]!;
  return { usually: at(0.5), slow: at(0.9) };
}
