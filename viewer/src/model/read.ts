/**
 * Raw profile documents in, the viewer's `Profile` out.
 *
 * One reader per schema version. Storage keeps the raw documents and they are
 * read on every load, so sessions stored today keep opening when the schema
 * moves on, and a better reader improves them too, with no migration.
 */

import { nodeLabel, roleOf, type RawNode } from "../lib/polars";
import type { Metrics, PlanNode, Profile, Session, StoredSession } from "./profile";

export const SCHEMA_PREFIX = "polars-telemetry/profile@";
export const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([1]);

export type Read = { profile: Profile } | { problem: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

export function readProfile(raw: unknown): Read {
  if (!isObject(raw)) return { problem: "not an object" };
  const schema = str(raw.schema);
  if (!schema.startsWith(SCHEMA_PREFIX)) return { problem: "not a polars-telemetry profile" };
  const version = Number(schema.slice(SCHEMA_PREFIX.length));
  if (!SUPPORTED_VERSIONS.has(version)) return { problem: `schema ${schema} needs a newer viewer` };
  return readV1(raw, schema);
}

const MAX_DATE_NS = 8.64e21;

function scalars(record: Record<string, unknown>): Record<string, number | boolean> {
  const kept: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "boolean" || Number.isFinite(value)) kept[key] = value as number | boolean;
  }
  return kept;
}

function readNodes(value: unknown, side: string): PlanNode[] | string {
  if (!Array.isArray(value)) return `plan.${side} is not an array`;
  const nodes: PlanNode[] = [];
  for (const entry of value) {
    if (!isObject(entry)) return `plan.${side} has a non-node entry`;
    if (!Number.isFinite(entry.id)) return `plan.${side} has a node without an id`;
    if (!Array.isArray(entry.inputs)) return `plan.${side} node ${String(entry.id)} has no inputs`;
    const node: RawNode = {
      id: entry.id as number,
      kind: str(entry.kind, "Unknown"),
      role: typeof entry.role === "string" ? entry.role : undefined,
      inputs: (entry.inputs as unknown[]).filter((i): i is number => Number.isFinite(i)),
      properties: isObject(entry.properties) ? entry.properties : {},
    };
    nodes.push({
      ...node,
      role: roleOf(node),
      label: nodeLabel(node),
      properties: node.properties ?? {},
      metrics: isObject(entry.metrics) ? (scalars(entry.metrics) as Metrics) : null,
    });
  }
  return nodes;
}

function readV1(raw: Record<string, unknown>, schema: string): Read {
  if (!isObject(raw.plan)) return { problem: "no plan" };
  const physical = readNodes(raw.plan.physical, "physical");
  if (typeof physical === "string") return { problem: physical };
  const logical = readNodes(raw.plan.logical, "logical");
  if (typeof logical === "string") return { problem: logical };

  const site = isObject(raw.call_site) ? raw.call_site : null;
  return {
    profile: {
      query_id: str(raw.query_id, crypto.randomUUID()),
      label: typeof raw.label === "string" && raw.label ? raw.label : null,
      redacted: Array.isArray(raw.redacted) ? raw.redacted.filter((k): k is string => typeof k === "string") : null,
      schema,
      polars_version: str(raw.polars_version, "unknown"),
      fingerprint: str(raw.fingerprint),
      started_unix_ns: Math.abs(num(raw.started_unix_ns)) <= MAX_DATE_NS ? num(raw.started_unix_ns) : 0,
      wall_ms: num(raw.wall_ms),
      cpu_ms: num(raw.cpu_ms),
      result_rows: Number.isFinite(raw.result_rows) ? (raw.result_rows as number) : null,
      call_site: site
        ? { filepath: str(site.filepath), lineno: num(site.lineno), function: str(site.function) }
        : null,
      failed: typeof raw.failed === "string" ? raw.failed : null,
      diagnostics: isObject(raw.diagnostics) ? scalars(raw.diagnostics) : {},
      plan: { physical, logical },
    },
  };
}

/** Profiles from a .jsonl file, and a reason for each line that is not one. */
export function readJsonl(text: string): { profiles: Profile[]; raw: unknown[]; rejected: string[] } {
  const profiles: Profile[] = [];
  const raw: unknown[] = [];
  const rejected: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      rejected.push("not valid JSON");
      continue;
    }
    const read = readProfile(parsed);
    if ("problem" in read) {
      rejected.push(read.problem);
    } else {
      profiles.push(read.profile);
      raw.push(parsed);
    }
  }
  return { profiles, raw, rejected };
}

/** A session's documents as a session file again, one per line. */
export const toJsonl = (raw: unknown[]): string =>
  raw.map((doc) => JSON.stringify(doc)).join("\n") + "\n";

/** A stored session, read. Profiles that no longer read are dropped one by one
 *  rather than taking the whole viewer down. */
export function readSession(stored: StoredSession): Session {
  const profiles: Profile[] = [];
  for (const raw of stored.profiles) {
    const read = readProfile(raw);
    if ("profile" in read) profiles.push(read.profile);
  }
  return { ...stored, profiles, raw: stored.profiles };
}
