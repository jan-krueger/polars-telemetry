import { gzipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { flowSeconds, liveFlow } from "../src/lib/graph";
import { gunzipText, isGzip } from "../src/lib/gzip";
import { busy, history, momentAt, nodeAt } from "../src/lib/replay";
import { EventLog } from "../src/model/events";
import { readJsonl, readProfile, toJsonl } from "../src/model/read";
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

const ended = [
  { rows_sent: 900, total_time_ns: 8e8, done: true },
  { rows_received: 900, rows_sent: 50, total_time_ns: 1e9, done: true },
  { rows_received: 50, total_time_ns: 1e8, done: true },
];
const finishedProfile = profileDoc({
  wall_ms: 3200,
  plan: { ...plan, physical: plan.physical.map((n, i) => ({ ...n, metrics: ended[i] })) },
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
    expect(replay.times).toEqual([1000, 2000, 3200]);
  });

  it("keep each node's samples only where its counters changed", () => {
    expect(replay.nodes.get(1)!.at).toEqual([0, 1, 2]);
    expect(replay.nodes.get(2)!.at).toEqual([0, 2]);
    expect(replay.nodes.get(3)!.at).toEqual([2]);
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

  it("can be followed one event at a time, as a live stream would arrive", () => {
    const log = new EventLog();
    expect(log.apply(progress1)).toBe("q1");
    expect(log.document("q1")).toBeNull();
    log.apply(started);
    const read = readProfile(log.document("q1"));
    expect("profile" in read && read.profile.unfinished).toBe(true);
    log.apply(progress2);
    log.apply(finished);
    expect(log.documents()).toHaveLength(1);
    expect(log.document("q1")).toMatchObject({ wall_ms: 3200 });
    expect(log.apply({ schema: EVENTS_SCHEMA, type: "process" })).toBeNull();
  });

  it("show a running query every counter it has reported so far", () => {
    const [cut] = readJsonl(toJsonl([started, progress1, event("query.progress", { elapsed_ms: 1500, nodes: { 1: { rows_sent: 600, total_time_ns: 5e8, morsels_sent: 3 } } })])).profiles;
    expect(Object.keys(cut!.plan.physical[0]!.metrics!)).toEqual(expect.arrayContaining(["rows_sent", "total_time_ns", "morsels_sent"]));
  });

  it("run on to how the query ended, after the last sample, and sort samples that arrived out of order", () => {
    expect(momentAt(replay, 2600).metrics.get(2)).toMatchObject({ rows_received: 650 });
    expect(momentAt(replay, 2600).state.get(3)).toBe("running");
    const shuffled = readJsonl(toJsonl([started, progress2, progress1, finished])).profiles[0]!.replay!;
    expect(shuffled.times).toEqual([1000, 2000, 3200]);
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

  it("are read up to the cut when the writing process died mid-batch", () => {
    const halves = [toJsonl([started]), toJsonl([finished])];
    const second = gzipSync(strToU8(halves[1]!));
    const cut = new Uint8Array([...gzipSync(strToU8(halves[0]!)), ...second.slice(0, 20)]);
    expect(gunzipText(cut)).toBe(halves[0]);
    expect(gunzipText(new Uint8Array([...gzipSync(strToU8(halves[0]!)), 0, 0, 0, 0]))).toBe(halves[0]);
  });

  it("share a query the recording cut off with its last counters", () => {
    const { raw } = readJsonl(toJsonl([started, progress1]));
    const opened = openShareFragment(shareFragment(raw));
    const [shared] = "documents" in opened ? readJsonl(toJsonl(opened.documents)).profiles : [];
    expect(shared!.replay).toBeNull();
    expect(shared!.plan.physical[0]!.metrics).toMatchObject({ rows_sent: 500 });
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

  it("keeps the rows moving at the latest sample, from the interval before it", () => {
    const [cut] = readJsonl(toJsonl([started, progress1, event("query.progress", { elapsed_ms: 1500, nodes: { 1: { rows_sent: 600, total_time_ns: 5e8 } } })])).profiles;
    expect(momentAt(cut!.replay!, 1500).flow.get(1)).toBeCloseTo(200);
    expect(momentAt(cut!.replay!, 1500).flow.get(2) ?? 0).toBe(0);
  });

  it("gives an unsampled node zero counters", () => {
    expect(nodeAt(profile.plan.physical[2]!, momentAt(replay, 1000)).metrics).toMatchObject({ total_time_ns: 0, done: false });
  });

  it("adds up how many threads the query kept busy between each two samples", () => {
    const threads = busy(replay, profile.plan.physical, profile.wall_ms);
    expect(threads.map((s) => [s.from, s.to])).toEqual([[0, 1000], [1000, 2000], [2000, 3200]]);
    expect(threads[0]!.load).toBeCloseTo(0.4);
    expect(threads[2]!.load).toBeCloseTo(1100 / 1200);
  });

  it("traces each counter from zero through every sample to its final value", () => {
    const [scan, , sink] = profile.plan.physical;
    expect(history(replay, scan!, profile.wall_ms, "total_time_ns")).toEqual([[0, 0], [1000, 4e8], [2000, 8e8], [3200, 8e8]]);
    expect(history(replay, sink!, profile.wall_ms, "rows_received")).toEqual([[0, 0], [1000, 0], [2000, 0], [3200, 50]]);
  });

  it("is laid over the plan: states on nodes, moving dots on edges with rows flowing", () => {
    const live = liveFlow(profile.plan.physical, momentAt(replay, 500));
    expect(["1", "2", "3"].map((id) => live.nodes.get(id)!.state)).toEqual(["running", "running", "waiting"]);
    expect(live.edges.get("1-2")!.rate).toBe(1 / flowSeconds(500));
    expect(live.edges.get("2-3")!.rate).toBeUndefined();
  });

  it("keeps each node and edge that did not change between two moments as the same object", () => {
    const first = liveFlow(profile.plan.physical, momentAt(replay, 1200));
    const second = liveFlow(profile.plan.physical, momentAt(replay, 1300), first);
    expect(["1", "2", "3"].map((id) => second.nodes.get(id) === first.nodes.get(id))).toEqual([false, true, true]);
    expect(["1-2", "2-3"].map((id) => second.edges.get(id) === first.edges.get(id))).toEqual([false, true]);
    expect(first.nodes.get("3")!.share).toBe(0);
    expect(first.nodes.get("1")!.share).toBeCloseTo((480 / 1900) * 100);
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
