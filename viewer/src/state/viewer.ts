/**
 * Everything the viewer is showing, and every way it can change.
 *
 * Selection is by `query_id` and session id, never by position, so reordering
 * or filtering a list cannot make it point at a different query. Each action
 * states once what it resets; before, six call sites each cleared their own
 * subset and two of them missed some.
 */

import type { PlanNode, Profile, Session } from "../model/profile";

export interface NodeRef {
  plan: "logical" | "physical";
  id: number;
}

export interface ViewerState {
  booted: boolean;
  sessions: Session[];
  sessionId: string | null;
  queryId: string | null;
  compareId: string | null;
  node: NodeRef | null;
}

export type Action =
  | { type: "loaded"; sessions: Session[] }
  | { type: "imported"; sessions: Session[] }
  | { type: "removed"; sessionId: string }
  | { type: "cleared" }
  | { type: "sessionPicked"; sessionId: string }
  | { type: "queryPicked"; queryId: string }
  | { type: "comparePicked"; queryId: string | null }
  | { type: "nodePicked"; node: NodeRef };

export const initialState: ViewerState = {
  booted: false,
  sessions: [],
  sessionId: null,
  queryId: null,
  compareId: null,
  node: null,
};

const nothingSelected = { queryId: null, compareId: null, node: null } as const;

export function reducer(state: ViewerState, action: Action): ViewerState {
  switch (action.type) {
    case "loaded": {
      const sessions = [...action.sessions].sort((a, b) => b.importedAt - a.importedAt);
      return { ...state, ...nothingSelected, booted: true, sessions, sessionId: sessions[0]?.id ?? null };
    }
    case "imported":
      if (!action.sessions.length) return state;
      return {
        ...state,
        ...nothingSelected,
        sessions: [...action.sessions, ...state.sessions],
        sessionId: action.sessions[0]!.id,
      };
    case "removed": {
      const sessions = state.sessions.filter((s) => s.id !== action.sessionId);
      if (state.sessionId !== action.sessionId) return { ...state, sessions };
      return { ...state, ...nothingSelected, sessions, sessionId: null };
    }
    case "cleared":
      return { ...state, ...nothingSelected, sessions: [], sessionId: null };
    case "sessionPicked":
      return { ...state, ...nothingSelected, sessionId: action.sessionId };
    case "queryPicked": {
      const profile = findProfile(currentSession(state), action.queryId);
      return { ...state, queryId: action.queryId, compareId: null, node: profile ? hottest(profile) : null };
    }
    case "comparePicked":
      return { ...state, compareId: action.queryId };
    case "nodePicked":
      return { ...state, node: action.node };
  }
}

// --- selectors ------------------------------------------------------------------

export const currentSession = (state: ViewerState): Session | null =>
  state.sessions.find((s) => s.id === state.sessionId) ?? null;

const findProfile = (session: Session | null, queryId: string | null): Profile | null =>
  (queryId && session?.profiles.find((p) => p.query_id === queryId)) || null;

export const currentProfile = (state: ViewerState): Profile | null =>
  findProfile(currentSession(state), state.queryId);

export const compareProfile = (state: ViewerState): Profile | null =>
  findProfile(currentSession(state), state.compareId);

export function findNode(profile: Profile | null, ref: NodeRef | null): PlanNode | null {
  if (!profile || !ref) return null;
  return profile.plan[ref.plan].find((n) => n.id === ref.id) ?? null;
}

/** The physical node with the most CPU: what a reader looks at first. */
export function hottest(profile: Profile): NodeRef | null {
  let best: PlanNode | null = null;
  for (const node of profile.plan.physical) {
    const time = Number(node.metrics?.total_time_ns);
    if (!Number.isFinite(time)) continue;
    if (!best || time > Number(best.metrics?.total_time_ns)) best = node;
  }
  return best ? { plan: "physical", id: best.id } : null;
}

export interface ShapeRow {
  fingerprint: string;
  runs: Profile[];
  wallMs: number;
  cpuMs: number;
}

/** Runs grouped by query shape, the most expensive shape first. */
export function shapes(profiles: Profile[]): ShapeRow[] {
  const byShape = new Map<string, ShapeRow>();
  for (const p of profiles) {
    const row = byShape.get(p.fingerprint) ?? { fingerprint: p.fingerprint, runs: [], wallMs: 0, cpuMs: 0 };
    row.runs.push(p);
    row.wallMs += p.wall_ms;
    row.cpuMs += p.cpu_ms;
    byShape.set(p.fingerprint, row);
  }
  return [...byShape.values()].sort((a, b) => b.wallMs - a.wallMs);
}
