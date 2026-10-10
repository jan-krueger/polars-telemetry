import { gzipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { flowSeconds, toFlow } from "../src/lib/graph";
import { gunzipText, isGzip } from "../src/lib/gzip";
import { finishes, momentAt, nodeAt } from "../src/lib/replay";
import { readJsonl, toJsonl } from "../src/model/read";
import { EVENTS_SCHEMA } from "../src/model/schema";
import { openShareFragment, shareFragment } from "../src/share/link";
import { initialState, reducer } from "../src/state/viewer";

const plan = {
  physical: [
    { id: 1, kind: "MultiScan", role: "scan", inputs: [] },
    { id: 2, kind: "GroupBy", role: "aggregation", inputs: [1] },
    { id: 3, kind: "InMemorySink", role: "sink", inputs: [2] },
  ],
  logical: [],
};
const event = (type: string, extra: Record<string, unknown>) => ({ schema: EVENTS_SCHEMA, type, query_id: "q1", ...extra });
const profileDoc = (extra: Record<string, unknown> = {}) =>
  ({ schema: "polars-telemetry/profile@1", query_id: "q1", label: "nightly", plan, ...extra });

const finishedProfile = profileDoc({
  wall_ms: 3200,
  plan: { ...plan, physical: plan.physical.map((n) => ({ ...n, metrics: { total_time_ns: 1e9, rows_sent: 10, done: true } })) },
});
const finished = event("query.finished", { profile: finishedProfile });
const started = event("query.started", { profile: profileDoc({ redacted: ["strings"] }) });
const progress1 = event("query.progress", { elapsed_ms: 1000, nodes: { 1: { rows_sent: 500, total_time_ns: 4e8 }, 2: { rows_received: 400 } } });
const progress2 = event("query.progress", { elapsed_ms: 2000, nodes: { 1: { rows_sent: 900, total_time_ns: 8e8, done: true } } });
const file = toJsonl([{ schema: EVENTS_SCHEMA, type: "process", host: "h", pid: 1 }, started, progress1, progress2, finished]);
const profile = readJsonl(file).profiles[0]!;
const replay = profile.replay!;

describe("events files", () => {
  it("become one profile per query, carrying its samples", () => {
    const { profiles, rejected } = readJsonl(file);
    expect(rejected).toEqual([]);
    expect(profiles).toHaveLength(1);
    expect(profile.wall_ms).toBe(3200);
    expect(replay.times).toEqual([1000, 2000]);
  });

  it("keep each node's samples only where its counters changed", () => {
    expect(replay.nodes.get(1)!.at).toEqual([0, 1]);
    expect(replay.nodes.get(2)!.at).toEqual([0]);
    expect(replay.nodes.has(3)).toBe(false);
  });

  it("keep a query the recording ended before, with its last counters and its masking", () => {
    const [cut] = readJsonl(toJsonl([started, progress1])).profiles;
    expect(cut!.unfinished).toBe(true);
    expect(cut!.failed).toBeNull();
    expect(cut!.redacted).toEqual(["strings"]);
    expect(cut!.wall_ms).toBe(1000);
    expect(cut!.cpu_ms).toBeCloseTo(400);
    expect(cut!.plan.physical.find((n) => n.id === 1)!.metrics).toMatchObject({ rows_sent: 500 });
  });

  it("leave a query without samples as it was", () => {
    const [plain] = readJsonl(toJsonl([finished])).profiles;
    expect(plain!.replay).toBeNull();
    expect(plain!.unfinished).toBe(false);
  });

  it("are read whole when gzipped as several members", () => {
    const halves = [toJsonl([started]), toJsonl([finished])];
    const both = new Uint8Array([...gzipSync(strToU8(halves[0]!)), ...gzipSync(strToU8(halves[1]!))]);
    expect(isGzip(both)).toBe(true);
    expect(gunzipText(both)).toBe(halves.join(""));
  });

  it("leave their samples out of share links", () => {
    const opened = openShareFragment(shareFragment([{ ...finishedProfile, replay: { samples: [] } }]));
    expect("documents" in opened && opened.documents[0]).not.toHaveProperty("replay");
  });
});

describe("a replayed moment", () => {
  it("has each node's counters, state and the CPU as they stood then", () => {
    const at = momentAt(replay, 1000);
    expect(at.cpu_ms).toBeCloseTo(400);
    expect([1, 2, 3].map((id) => at.state.get(id) ?? "waiting")).toEqual(["running", "running", "waiting"]);
    expect(momentAt(replay, 2000).state.get(1)).toBe("done");
  });

  it("interpolates counters between two samples, and before the first", () => {
    expect(momentAt(replay, 1500).metrics.get(1)).toMatchObject({ rows_sent: 700, done: false });
    expect(momentAt(replay, 500).metrics.get(1)!.rows_sent).toBe(250);
  });

  it("keeps the last sample's counters after it", () => {
    expect(momentAt(replay, 3000).metrics.get(1)).toMatchObject({ rows_sent: 900, done: true });
  });

  it("knows how many rows each running node sends per second in the current interval", () => {
    expect(momentAt(replay, 500).flow.get(1)).toBe(500);
    expect(momentAt(replay, 1500).flow.get(1)).toBe(400);
    expect(momentAt(replay, 1500).flow.get(2) ?? 0).toBe(0);
  });

  it("gives an unsampled node zero counters", () => {
    expect(nodeAt(profile.plan.physical[2]!, momentAt(replay, 1000)).metrics).toMatchObject({ total_time_ns: 0, done: false });
  });

  it("marks when each node finished", () => {
    expect(finishes(replay)).toEqual([2000]);
  });

  it("is drawn as an overlay: states on nodes, moving dots on edges with rows flowing", () => {
    const positions = Object.fromEntries(plan.physical.map((n) => [String(n.id), { x: 0, y: 0 }]));
    const { nodes, edges } = toFlow(profile.plan.physical, positions, { logical: false, selectedId: null, moment: momentAt(replay, 500) });
    expect(nodes.map((n) => n.data.live)).toEqual(["running", "running", "waiting"]);
    const scan = edges.find((e) => e.source === "1")!;
    expect(scan.className).toContain("flowing");
    expect(scan.data).toEqual({ rate: 1 / flowSeconds(500) });
    expect(edges.find((e) => e.source === "2")!.data).toEqual({});
  });

  it("moves the dots faster for more rows, within readable bounds", () => {
    expect(flowSeconds(10)).toBe(1.6);
    expect(flowSeconds(1e5)).toBeLessThan(flowSeconds(1e4));
    expect(flowSeconds(1e12)).toBe(0.25);
  });

  it("is forgotten when another query opens", () => {
    const state = { ...initialState, queryId: "q1", replayAt: 1000 };
    expect(reducer(state, { type: "replayed", at: 0 }).replayAt).toBe(0);
    expect(reducer(state, { type: "queryPicked", queryId: "q2" }).replayAt).toBeNull();
  });
});
