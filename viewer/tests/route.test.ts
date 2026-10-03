import { describe, expect, it } from "vitest";
import { fromHash, isNewPage, toHash, type Route } from "../src/state/route";
import { initialState, reducer } from "../src/state/viewer";
import { readProfile } from "../src/model/read";
import type { Profile, Session } from "../src/model/profile";

const profile = (id: string): Profile => {
  const read = readProfile({
    schema: "polars-telemetry/profile@1", query_id: id, wall_ms: 1,
    plan: {
      physical: [
        { id: 1, kind: "Filter", inputs: [], metrics: { total_time_ns: 10 } },
        { id: 2, kind: "Filter", inputs: [], metrics: { total_time_ns: 90 } },
      ],
      logical: [{ id: 7, kind: "Filter", inputs: [] }],
    },
  });
  if ("problem" in read) throw new Error(read.problem);
  return read.profile;
};
const session = (id: string, ...profiles: Profile[]): Session =>
  ({ id, name: id, importedAt: 0, bytes: 0, profiles, raw: [] });
const loaded = reducer(initialState, {
  type: "loaded", sessions: [session("s1", profile("a"), profile("b")), session("s2", profile("c"))],
});
const route = (over: Partial<Route>): Route => ({ sessionId: null, queryId: null, node: null, ...over });

describe("route", () => {
  it("round-trips through the hash, ids with odd characters included", () => {
    const r = route({ sessionId: "s 1/&", queryId: "q#1", node: { plan: "logical", id: 7 } });
    expect(fromHash(toHash(r))).toEqual(r);
    expect(toHash(route({}))).toBe("");
    expect(fromHash("")).toEqual(route({}));
  });

  it("ignores a node it cannot read", () => {
    expect(fromHash("#s=s1&q=a&n=sideways.3").node).toBeNull();
    expect(fromHash("#s=s1&q=a&n=physical.x").node).toBeNull();
  });

  it("opens the session, query and node a link names", () => {
    const state = reducer(loaded, { type: "navigated", route: fromHash("#s=s1&q=b&n=logical.7") });
    expect([state.sessionId, state.queryId, state.node]).toEqual(["s1", "b", { plan: "logical", id: 7 }]);
  });

  it("selects the hottest node when the link names none, or one not in the plan", () => {
    for (const hash of ["#s=s1&q=a", "#s=s1&q=a&n=physical.99"]) {
      expect(reducer(loaded, { type: "navigated", route: fromHash(hash) }).node).toEqual({ plan: "physical", id: 2 });
    }
  });

  it("falls back to a session that is here when the link's is not", () => {
    const state = reducer(loaded, { type: "navigated", route: fromHash("#s=elsewhere&q=a") });
    expect(state.sessionId).toBe(loaded.sessions[0]!.id);
    expect(state.queryId).toBe("a");
  });

  it("adds history for a new query, not for a new node", () => {
    const a = route({ sessionId: "s1", queryId: "a", node: { plan: "physical", id: 1 } });
    expect(isNewPage(a, { ...a, node: { plan: "physical", id: 2 } })).toBe(false);
    expect(isNewPage(a, { ...a, queryId: "b" })).toBe(true);
  });
});
