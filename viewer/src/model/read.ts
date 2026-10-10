// Storage keeps raw documents and reads them on every load: no migrations, and a newer reader improves old sessions.

import { nodeMarks, nodeSubject, nodeVariant, roleOf, type RawNode } from "../lib/polars";
import type { CustomMetric, Finding, FindingLevel, Measure, Metrics, PlanNode, Profile, Replay, Series, SessionInfo } from "./profile";
import { isEvent, profilesFromEvents } from "./events";
import { SCHEMA_PREFIX, isObject } from "./schema";
import { ranOf } from "../lib/time";

export const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([1]);

export type Read = { profile: Profile } | { problem: string };

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

/** `position` gives a profile without a query_id a stable id. */
export function readProfile(raw: unknown, position?: number): Read {
  if (!isObject(raw)) return { problem: "not an object" };
  const schema = str(raw.schema);
  if (!schema.startsWith(SCHEMA_PREFIX)) return { problem: "not a polars-telemetry profile" };
  const version = Number(schema.slice(SCHEMA_PREFIX.length));
  if (!SUPPORTED_VERSIONS.has(version)) return { problem: `schema ${schema} needs a newer viewer` };
  return readV1(raw, schema, position);
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
      label: nodeSubject(node),
      variant: nodeVariant(node),
      marks: nodeMarks(node),
      properties: node.properties ?? {},
      metrics: isObject(entry.metrics) ? (scalars(entry.metrics) as Metrics) : null,
      custom: isObject(entry.metrics) && Array.isArray(entry.metrics.custom) ? entry.metrics.custom.flatMap(readCustom) : [],
    });
  }
  return nodes;
}

function readCustom(c: unknown): CustomMetric[] {
  if (!isObject(c) || typeof c.key !== "string") return [];
  return [{ key: c.key, unit: typeof c.unit === "string" ? c.unit : "1", value: Number.isFinite(c.value) ? (c.value as number) : null }];
}

function readV1(raw: Record<string, unknown>, schema: string, position?: number): Read {
  if (!isObject(raw.plan)) return { problem: "no plan" };
  const physical = readNodes(raw.plan.physical, "physical");
  if (typeof physical === "string") return { problem: physical };
  const logical = readNodes(raw.plan.logical, "logical");
  if (typeof logical === "string") return { problem: logical };

  const site = isObject(raw.call_site) ? raw.call_site : null;
  const unfinished = raw.unfinished === true;
  const replay = readReplay(raw.replay, unfinished ? null : physical, num(raw.wall_ms));
  const nodes = unfinished ? lastCounters(physical, replay) : physical;
  return {
    profile: {
      query_id: str(raw.query_id) || (position === undefined ? crypto.randomUUID() : `profile-${position}`),
      label: typeof raw.label === "string" && raw.label ? raw.label : null,
      redacted: Array.isArray(raw.redacted) ? raw.redacted.filter((k): k is string => typeof k === "string") : null,
      schema,
      polars_version: str(raw.polars_version, "unknown"),
      fingerprint: str(raw.fingerprint),
      started_unix_ns: Math.abs(num(raw.started_unix_ns)) <= MAX_DATE_NS ? num(raw.started_unix_ns) : 0,
      wall_ms: num(raw.wall_ms),
      planning_ms: Number.isFinite(raw.planning_ms) ? (raw.planning_ms as number) : null,
      telemetry_ms: Number.isFinite(raw.telemetry_ms) ? (raw.telemetry_ms as number) : null,
      cpu_ms: unfinished ? nodes.reduce((sum, n) => sum + num(n.metrics?.total_time_ns), 0) / 1e6 : num(raw.cpu_ms),
      result_rows: Number.isFinite(raw.result_rows) ? (raw.result_rows as number) : null,
      call_site: site
        ? { filepath: str(site.filepath), lineno: num(site.lineno), function: str(site.function) }
        : null,
      failed: typeof raw.failed === "string" ? raw.failed : null,
      diagnostics: isObject(raw.diagnostics) ? scalars(raw.diagnostics) : {},
      insights: readInsights(raw.insights),
      plan: { physical: nodes, logical },
      replay,
      unfinished,
    },
  };
}

/**
 * Each sample lists only the nodes whose counters changed; keep it that sparse. A finished query's own
 * counters close the replay as one more sample at its end, so it runs all the way to how the query ended.
 */
function readReplay(value: unknown, final: PlanNode[] | null, end: number): Replay | null {
  if (!isObject(value) || !Array.isArray(value.samples)) return null;
  const byTime = new Map<number, Record<string, unknown>>();
  for (const sample of value.samples) {
    if (!isObject(sample) || !Number.isFinite(sample.t)) continue;
    const nodes = isObject(sample.nodes) ? sample.nodes : {};
    byTime.set(sample.t as number, { ...byTime.get(sample.t as number), ...nodes });
  }
  if (!byTime.size) return null;
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const nodes = new Map<number, Series>();
  const record = (id: number, index: number, metrics: Metrics) => {
    let series = nodes.get(id);
    if (!series) nodes.set(id, (series = { at: [], metrics: [] }));
    if (series.at[series.at.length - 1] === index) series.metrics[series.metrics.length - 1] = metrics;
    else {
      series.at.push(index);
      series.metrics.push(metrics);
    }
  };
  times.forEach((t, index) => {
    for (const [key, counters] of Object.entries(byTime.get(t)!)) {
      const id = Number(key);
      if (isObject(counters) && Number.isFinite(id)) record(id, index, scalars(counters) as Metrics);
    }
  });
  if (final) {
    const index = end > times[times.length - 1]! ? times.push(end) - 1 : times.length - 1;
    for (const node of final) if (node.metrics) record(node.id, index, node.metrics);
  }
  return { times, nodes };
}

/** A query the recording ended before keeps the counters of its last sample. */
function lastCounters(nodes: PlanNode[], replay: Replay | null): PlanNode[] {
  if (!replay) return nodes;
  return nodes.map((n) => (n.metrics ? n : { ...n, metrics: replay.nodes.get(n.id)?.metrics.at(-1) ?? null }));
}

export function readJsonl(text: string): { profiles: Profile[]; raw: unknown[]; rejected: string[] } {
  const profiles: Profile[] = [];
  const raw: unknown[] = [];
  const rejected: string[] = [];
  const parsedLines: unknown[] = [];
  const events: Record<string, unknown>[] = [];
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
    if (isEvent(parsed)) events.push(parsed);
    else parsedLines.push(parsed);
  }
  for (const parsed of [...parsedLines, ...profilesFromEvents(events)]) {
    const read = readProfile(parsed, raw.length);
    if ("problem" in read) {
      rejected.push(read.problem);
    } else {
      profiles.push(read.profile);
      raw.push(parsed);
    }
  }
  return { profiles, raw, rejected };
}

export const toJsonl = (raw: unknown[]): string =>
  raw.map((doc) => JSON.stringify(doc)).join("\n") + "\n";

/** Drops profiles that no longer read, one by one. */
export function readProfiles(raw: unknown[]): Profile[] {
  const profiles: Profile[] = [];
  for (const [position, document] of raw.entries()) {
    const read = readProfile(document, position);
    if ("profile" in read) profiles.push(read.profile);
  }
  return profiles;
}

export function sessionInfo(
  base: Pick<SessionInfo, "id" | "name" | "importedAt" | "bytes"> & { openedAt?: number | null },
  profiles: Profile[],
): SessionInfo {
  return {
    id: base.id,
    name: base.name,
    importedAt: base.importedAt,
    openedAt: base.openedAt ?? null,
    bytes: base.bytes,
    count: profiles.length,
    runIds: profiles.map((p) => p.query_id),
    ran: ranOf(profiles.map((p) => p.started_unix_ns)),
  };
}

const LEVELS: readonly FindingLevel[] = ["warn", "info", "applied"];

/** Malformed findings are dropped, never guessed. */
function readInsights(raw: unknown): Finding[] | null {
  if (!isObject(raw) || raw.schema !== "insights@1" || !Array.isArray(raw.findings)) return null;
  return raw.findings.flatMap((f): Finding[] => {
    if (!isObject(f) || !LEVELS.includes(f.level as FindingLevel) || !Number.isFinite(f.node_id)) return [];
    return [{
      rule: str(f.rule),
      kind: f.kind === "applied" ? "applied" : "problem",
      level: f.level as FindingLevel,
      node_id: f.node_id as number,
      node_kind: str(f.node_kind),
      cpu_share: num(f.cpu_share),
      blocked_share: num(f.blocked_share),
      title: str(f.title),
      fix: str(f.fix),
      evidence: Array.isArray(f.evidence) ? f.evidence.flatMap(readMeasure) : [],
    }];
  });
}

const UNITS: readonly Measure["unit"][] = ["rows", "count", "ms", "share", "ratio"];

function readMeasure(m: unknown): Measure[] {
  if (!isObject(m) || typeof m.name !== "string" || !Number.isFinite(m.value)) return [];
  const unit = UNITS.includes(m.unit as Measure["unit"]) ? (m.unit as Measure["unit"]) : "count";
  return [{ name: m.name, value: m.value as number, unit }];
}
