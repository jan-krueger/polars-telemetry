import { describe, expect, it } from "vitest";
import { readProfile, sessionInfo } from "../src/model/read";
import type { Profile, Session } from "../src/model/profile";
import { currentProfile, initialState, matches, reducer, sameRuns, sharedPrefix, shapes, sortShapes, title, visibleShapes, type ViewerState } from "../src/state/viewer";

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
  ({ ...sessionInfo({ id, name: `${id}.jsonl`, importedAt: Number(id.slice(1)), bytes: 0 }, profiles), profiles, raw: [] });
const unread = (s: Session): Session => ({ ...s, profiles: null, raw: null });

const loaded = (...sessions: Session[]): ViewerState =>
  reducer(initialState, { type: "loaded", sessions });

const busy = (): ViewerState => {
  let state = loaded(session("s1", profile("a", "f1", 5), profile("b", "f1", 9)), session("s2"));
  state = reducer(state, { type: "sessionPicked", sessionId: "s1" });
  return reducer(state, { type: "queryPicked", queryId: "a" });
};

describe("viewer state", () => {
  it("opens on the most recently imported session", () => {
    expect(loaded(session("s1"), session("s2")).sessionId).toBe("s2");
  });

  it("picking a query selects its hottest node", () => {
    const state = reducer(busy(), { type: "queryPicked", queryId: "b" });
    expect(state.node).toEqual({ plan: "physical", id: 7 });
  });

  it("picking a session clears the query and the node", () => {
    const state = reducer(busy(), { type: "sessionPicked", sessionId: "s2" });
    expect([state.queryId, state.node]).toEqual([null, null]);
  });

  it("removing the open session opens the next, with nothing selected", () => {
    const state = reducer(busy(), { type: "removed", sessionIds: ["s1"] });
    expect([state.sessionId, state.queryId, state.node]).toEqual(["s2", null, null]);
  });

  it("removing the last session leaves none open", () => {
    let state = reducer(busy(), { type: "removed", sessionIds: ["s1"] });
    state = reducer(state, { type: "removed", sessionIds: ["s2"] });
    expect(state.sessionId).toBeNull();
  });

  it("removing another session keeps the selection", () => {
    const state = reducer(busy(), { type: "removed", sessionIds: ["s2"] });
    expect(state.queryId).toBe("a");
  });

  it("clearing everything leaves nothing selected", () => {
    const state = reducer(busy(), { type: "cleared" });
    expect([state.sessions.length, state.queryId, state.node]).toEqual([0, null, null]);
  });

  it("keeping a shared session leaves it open and stops showing it as a link", () => {
    const shared = { ...session("s3", profile("a", "f", 1)), shared: "#share=1.x" };
    const kept = reducer(reducer(loaded(session("s1")), { type: "imported", sessions: [shared] }),
                         { type: "kept", sessionId: "s3" });
    expect(kept.sessionId).toBe("s3");
    expect(kept.sessions.find((s) => s.id === "s3")?.shared).toBeUndefined();
  });

  it("renaming a session keeps it open and leaves the others alone", () => {
    const renamed = reducer(loaded(session("s1"), session("s2")), { type: "renamed", sessionId: "s1", name: "nightly" });
    expect(renamed.sessions.map((s) => s.name)).toEqual(["s2.jsonl", "nightly"]);
    expect(renamed.sessionId).toBe(loaded(session("s1"), session("s2")).sessionId);
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
    state = { ...state, sessions: state.sessions.map((s) => (s === s1 ? { ...s, profiles: [...s.profiles!].reverse() } : s)) };
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

describe("execution order", () => {
  const at = (id: string, fingerprint: string, started: number) => ({ ...profile(id, fingerprint, 1), started_unix_ns: started });

  it("numbers shapes by their first run's start and lists them in that order by default", () => {
    const state = loaded(session("s1", at("a", "late", 30), at("b", "early", 10), at("c", "late", 20), at("d", "mid", 25)));
    const rows = visibleShapes(state);
    expect(rows.map((r) => [r.fingerprint, r.order])).toEqual([["early", 1], ["late", 2], ["mid", 3]]);
    expect(state.sort).toEqual({ key: "order", descending: false });
  });

  it("falls back to the session's order without start times", () => {
    const rows = shapes([at("a", "x", 0), at("b", "y", 0), at("c", "x", 0)]);
    expect(Object.fromEntries(rows.map((r) => [r.fingerprint, r.order]))).toEqual({ x: 1, y: 2 });
  });

  it("starts ascending when picked again after another column", () => {
    let state = reducer(initialState, { type: "sorted", key: "wall" });
    state = reducer(state, { type: "sorted", key: "order" });
    expect(state.sort).toEqual({ key: "order", descending: false });
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

describe("sessions read when opened", () => {
  it("opens on the most recently opened session, else the newest import", () => {
    const s1 = { ...unread(session("s1")), openedAt: 50 };
    expect(loaded(s1, unread(session("s2"))).sessionId).toBe("s1");
  });

  it("a link into a session not read yet waits for its profiles, then checks them", () => {
    const s1 = session("s1", profile("a", "f1", 5), profile("b", "f1", 9));
    let state = loaded(unread(s1));
    state = reducer(state, { type: "navigated", route: { sessionId: "s1", queryId: "b", node: { plan: "physical", id: 3 } } });
    expect([state.queryId, state.node]).toEqual(["b", { plan: "physical", id: 3 }]);
    state = reducer(state, { type: "read", sessionId: "s1", profiles: s1.profiles!, raw: [], forgetOthers: true });
    expect(currentProfile(state)?.query_id).toBe("b");
    expect(state.node).toEqual({ plan: "physical", id: 7 });
  });

  it("reading one session forgets the other stored ones, but never a link session", () => {
    const shared = { ...session("s3", profile("c", "f", 1)), shared: "#share=1.x" };
    let state = loaded(session("s1", profile("a", "f1", 5)), session("s2", profile("b", "f2", 5)), shared);
    state = reducer(state, { type: "read", sessionId: "s2", profiles: [profile("b", "f2", 5)], raw: [], forgetOthers: true });
    expect(state.sessions.map((s) => [s.id, s.profiles !== null])).toEqual(
      expect.arrayContaining([["s1", false], ["s2", true], ["s3", true]]));
  });

  it("removes several sessions at once and opens the most recent one left", () => {
    const state = reducer(busy(), { type: "removed", sessionIds: ["s1", "s9"] });
    expect(state.sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(state.sessionId).toBe("s2");
  });
});

describe("storage that opens after the page", () => {
  it("adds the stored sessions to an empty page and opens the newest", () => {
    const state = reducer(loaded(), { type: "stored", sessions: [unread(session("s1")), unread(session("s2"))] });
    expect(state.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(state.sessionId).toBe("s2");
  });

  it("keeps what was opened meanwhile, and does not add it twice", () => {
    let state = reducer(loaded(), { type: "imported", sessions: [session("s5", profile("a", "f1", 5))] });
    state = reducer(state, { type: "stored", sessions: [unread(session("s1")), unread(session("s5"))] });
    expect(state.sessions.map((s) => s.id)).toEqual(["s5", "s1"]);
    expect(state.sessionId).toBe("s5");
    expect(state.sessions[0]!.profiles).not.toBeNull();
  });
});

describe("the sessions page", () => {
  it("closes once the last session is removed, and stays open while some are left", () => {
    let state = reducer(loaded(session("s1"), session("s2")), { type: "browsed", open: true });
    state = reducer(state, { type: "removed", sessionIds: ["s1"] });
    expect(state.browsing).toBe(true);
    state = reducer(state, { type: "removed", sessionIds: ["s2"] });
    expect([state.browsing, state.sessions.length, state.sessionId]).toEqual([false, 0, null]);
  });

  it("closes when everything is cleared", () => {
    const state = reducer(reducer(loaded(session("s1")), { type: "browsed", open: true }), { type: "cleared" });
    expect(state.browsing).toBe(false);
  });

  it("closes when a query or a page from history is opened", () => {
    const browsing = reducer(busy(), { type: "browsed", open: true });
    expect(reducer(browsing, { type: "queryPicked", queryId: "b" }).browsing).toBe(false);
    expect(reducer(browsing, { type: "navigated", route: { sessionId: "s1", queryId: "a", node: null } }).browsing).toBe(false);
  });
});

describe("opening a file twice", () => {
  const run = (query_id: string) => ({ query_id }) as Profile;
  const session = (id: string, ids: string[]) =>
    ({ id, name: id, importedAt: 0, openedAt: null, bytes: 0, count: ids.length, runIds: ids, ran: null,
       profiles: null, raw: null }) as Session;
  const open = [session("a", ["1", "2"]), session("b", ["3"])];

  it("finds the session holding exactly the same runs, in any order", () => {
    expect(sameRuns(open, [run("2"), run("1")])?.id).toBe("a");
  });

  it("treats a file with more or fewer runs as new", () => {
    expect(sameRuns(open, [run("1")])).toBeNull();
    expect(sameRuns(open, [run("3"), run("4")])).toBeNull();
  });
});

describe("shared label prefix", () => {
  const labelled = (label: string) => ({ label, plan: { logical: [], physical: [] } }) as unknown as Profile;

  it("is the leading path every label shares, whole segments only", () => {
    const ps = ["etl/load/orders", "etl/load/items", "etl/write"].map(labelled);
    expect(sharedPrefix(ps)).toBe("etl/");
    expect(sharedPrefix(["etl/loading", "etl/load"].map(labelled))).toBe("etl/");
  });

  it("never swallows a whole label, and needs two queries", () => {
    expect(sharedPrefix(["etl/a", "etl/a"].map(labelled))).toBe("etl/");
    expect(sharedPrefix(["etl", "etl/a"].map(labelled))).toBe("");
    expect(sharedPrefix([labelled("etl/a")])).toBe("");
  });
});
