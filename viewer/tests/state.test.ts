import { describe, expect, it } from "vitest";
import { readProfile } from "../src/model/read";
import type { Profile, Session } from "../src/model/profile";
import { currentProfile, initialState, matches, reducer, shapes, sortShapes, title, visibleShapes, type ViewerState } from "../src/state/viewer";

function profile(id: string, fingerprint: string, wall: number, hotNode = 7): Profile {
  const result = readProfile({
    schema: "polars-telemetry/profile@1",
    query_id: id,
    fingerprint,
    wall_ms: wall,
    plan: {
      physical: [
        { id: 1, kind: "Filter", inputs: [], metrics: { total_time_ns: 10 } },
        { id: hotNode, kind: "GroupBy", inputs: [1], metrics: { total_time_ns: 99 } },
      ],
      logical: [],
    },
  });
  if ("problem" in result) throw new Error(result.problem);
  return result.profile;
}

const session = (id: string, ...profiles: Profile[]): Session =>
  ({ id, name: `${id}.jsonl`, importedAt: Number(id.slice(1)), bytes: 0, profiles, raw: [] });

const loaded = (...sessions: Session[]): ViewerState =>
  reducer(initialState, { type: "loaded", sessions });

const busy = (): ViewerState => {
  let state = loaded(session("s1", profile("a", "f1", 5), profile("b", "f1", 9)), session("s2"));
  state = reducer(state, { type: "sessionPicked", sessionId: "s1" });
  state = reducer(state, { type: "queryPicked", queryId: "a" });
  return reducer(state, { type: "comparePicked", queryId: "b" });
};

describe("viewer state", () => {
  it("opens on the most recently imported session", () => {
    expect(loaded(session("s1"), session("s2")).sessionId).toBe("s2");
  });

  it("picking a query selects its hottest node and clears the comparison", () => {
    const state = reducer(busy(), { type: "queryPicked", queryId: "b" });
    expect(state.node).toEqual({ plan: "physical", id: 7 });
    expect(state.compareId).toBeNull();
  });

  it("picking a session clears the query, the comparison and the node", () => {
    const state = reducer(busy(), { type: "sessionPicked", sessionId: "s2" });
    expect([state.queryId, state.compareId, state.node]).toEqual([null, null, null]);
  });

  it("removing the open session clears everything selected in it", () => {
    const state = reducer(busy(), { type: "removed", sessionId: "s1" });
    expect([state.sessionId, state.queryId, state.compareId, state.node]).toEqual([null, null, null, null]);
  });

  it("removing another session keeps the selection", () => {
    const state = reducer(busy(), { type: "removed", sessionId: "s2" });
    expect(state.queryId).toBe("a");
    expect(state.compareId).toBe("b");
  });

  it("clearing everything leaves nothing selected", () => {
    const state = reducer(busy(), { type: "cleared" });
    expect([state.sessions.length, state.queryId, state.compareId, state.node]).toEqual([0, null, null, null]);
  });

  it("importing selects the first new session", () => {
    const state = reducer(busy(), { type: "imported", sessions: [session("s3")] });
    expect(state.sessionId).toBe("s3");
    expect(state.queryId).toBeNull();
  });

  it("selection follows the query, not its position in the list", () => {
    let state = busy();
    const before = currentProfile(state);
    const s1 = state.sessions.find((s) => s.id === "s1")!;
    state = { ...state, sessions: state.sessions.map((s) => (s === s1 ? { ...s, profiles: [...s.profiles].reverse() } : s)) };
    expect(currentProfile(state)).toBe(before);
  });
});

describe("shapes", () => {
  it("groups runs by fingerprint, the most expensive shape first", () => {
    const rows = shapes([profile("a", "f1", 5), profile("b", "f2", 50), profile("c", "f1", 1)]);
    expect(rows.map((r) => [r.fingerprint, r.runs.length])).toEqual([["f2", 1], ["f1", 2]]);
  });
});

describe("search", () => {
  const labelled = (id: string, label: string | null, fingerprint: string) => {
    const read = readProfile({
      schema: "polars-telemetry/profile@1", query_id: id, label, fingerprint, wall_ms: 1,
      call_site: { filepath: `/srv/queries/${id}.py`, lineno: 12, function: "q" },
      plan: { physical: [{ id: 1, kind: "Filter", inputs: [] }], logical: [] },
    });
    if ("problem" in read) throw new Error(read.problem);
    return read.profile;
  };
  const q3 = labelled("q3", "tpch/q3", "f3");
  const q9 = labelled("q9", "tpch/q9", "f9");

  it.each([
    ["the label", "tpch/q3"],
    ["part of a nested label", "q3"],
    ["the call site file", "q3.py"],
    ["the fingerprint", "f3"],
  ])("matches by %s", (_, search) => {
    expect(matches(q3, search)).toBe(true);
    expect(matches(q9, search)).toBe(false);
  });

  it("ignores case and surrounding space", () => {
    expect(matches(q3, "  TPCH/Q3 ")).toBe(true);
  });

  it("narrows the listed shapes, and an empty search lists them all", () => {
    let state = reducer(initialState, { type: "loaded", sessions: [session("s1", q3, q9)] });
    expect(visibleShapes(state)).toHaveLength(2);
    state = reducer(state, { type: "searched", text: "q9" });
    expect(visibleShapes(state).map((r) => r.fingerprint)).toEqual(["f9"]);
  });

  it("is titled by its label, else by its shape", () => {
    expect(title(q3)).toBe("tpch/q3");
    expect(title(labelled("x", null, "fx"))).not.toBe("");
  });
});

describe("sorting", () => {
  const run = (label: string, wall_ms: number, cpu_ms = 1) => {
    const read = readProfile({
      schema: "polars-telemetry/profile@1", query_id: crypto.randomUUID(), label, fingerprint: label,
      wall_ms, cpu_ms, plan: { physical: [{ id: 1, kind: "Filter", inputs: [] }], logical: [] },
    });
    if ("problem" in read) throw new Error(read.problem);
    return read.profile;
  };
  const rows = shapes([run("tpch/q10", 5), run("tpch/q2", 50), run("tpch/q1", 20), run("tpch/q1", 1)]);
  const names = (sorted: ReturnType<typeof shapes>) => sorted.map((r) => r.fingerprint);

  it("starts with the most expensive shape", () => {
    expect(names(visibleShapes(reducer(initialState, { type: "loaded", sessions: [session("s1", ...rows.flatMap((r) => r.runs))] }))))
      .toEqual(["tpch/q2", "tpch/q1", "tpch/q10"]);
  });

  it("sorts names as numbers would read", () => {
    expect(names(sortShapes(rows, { key: "name", descending: false }))).toEqual(["tpch/q1", "tpch/q2", "tpch/q10"]);
  });

  it("starts a name column A to Z and a number column largest first, and flips on a second click", () => {
    let state = reducer(initialState, { type: "sorted", key: "name" });
    expect(state.sort).toEqual({ key: "name", descending: false });
    state = reducer(state, { type: "sorted", key: "name" });
    expect(state.sort).toEqual({ key: "name", descending: true });
    state = reducer(state, { type: "sorted", key: "runs" });
    expect(state.sort).toEqual({ key: "runs", descending: true });
    expect(names(sortShapes(rows, state.sort))[0]).toBe("tpch/q1");
  });
});

describe("focus", () => {
  it("is a view setting that survives picking another query", () => {
    expect(initialState.focus).toBeNull();
    let state = reducer(initialState, { type: "focused", focus: 82 });
    state = reducer(state, { type: "queryPicked", queryId: "x" });
    expect(state.focus).toBe(82);
  });
});
