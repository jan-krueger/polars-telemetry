import { describe, expect, it } from "vitest";
import { readProfile } from "../src/model/read";
import type { Profile, Session } from "../src/model/profile";
import { currentProfile, initialState, reducer, shapes, type ViewerState } from "../src/state/viewer";

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
  ({ id, name: `${id}.jsonl`, importedAt: Number(id.slice(1)), bytes: 0, profiles });

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
