/**
 * Everything the viewer is showing, and every way it can change.
 *
 * Selection is by `query_id` and session id, never by position, so reordering
 * or filtering a list cannot make it point at a different query. Each action
 * states once what it resets; before, six call sites each cleared their own
 * subset and two of them missed some.
 */

import type { PlanNode, Profile, Session } from "../model/profile";
import { shapeName } from "../lib/format";
import type { Route } from "./route";

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
  /** Filters the query list; kept across sessions, as a view setting. */
  search: string;
  /** Orders the query list and overview; a view setting too. */
  sort: Sort;
  /** Light only the nodes covering this percent of CPU time; null lights all.
   *  A share rather than a count, so it means the same on every plan. */
  focus: number | null;
}

export type SortKey = "name" | "runs" | "wall" | "cpu";
export interface Sort {
  key: SortKey;
  descending: boolean;
}

export type Action =
  | { type: "loaded"; sessions: Session[] }
  | { type: "imported"; sessions: Session[] }
  | { type: "removed"; sessionId: string }
  | { type: "cleared" }
  | { type: "sessionPicked"; sessionId: string }
  | { type: "queryPicked"; queryId: string }
  | { type: "comparePicked"; queryId: string | null }
  | { type: "nodePicked"; node: NodeRef }
  | { type: "searched"; text: string }
  | { type: "sorted"; key: SortKey }
  | { type: "focused"; focus: number | null }
  | { type: "navigated"; route: Route };

export const initialState: ViewerState = {
  booted: false,
  sessions: [],
  sessionId: null,
  queryId: null,
  compareId: null,
  node: null,
  search: "",
  sort: { key: "wall", descending: true },
  focus: null,
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
      return { ...state, ...nothingSelected, sessions, sessionId: sessions[0]?.id ?? null };
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
    case "searched":
      return { ...state, search: action.text };
    case "navigated": {
      // A link to a session or query that is not here falls back to what is.
      const { route } = action;
      const session = state.sessions.find((s) => s.id === route.sessionId) ?? state.sessions[0] ?? null;
      const profile = findProfile(session, route.queryId);
      const node = profile && route.node && findNode(profile, route.node) ? route.node : profile && hottest(profile);
      return {
        ...state,
        ...nothingSelected,
        sessionId: session?.id ?? null,
        queryId: profile?.query_id ?? null,
        node: node || null,
      };
    }
    case "focused":
      return { ...state, focus: action.focus };
    case "sorted": {
      // The same column again flips it; a new one starts where it reads best:
      // names A to Z, numbers largest first.
      const descending = state.sort.key === action.key ? !state.sort.descending : action.key !== "name";
      return { ...state, sort: { key: action.key, descending } };
    }
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

/** What a search matches: the label, where it ran, the shape, the fingerprint. */
export function matches(profile: Profile, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const site = profile.call_site;
  const haystack = [
    profile.label,
    site && `${site.filepath.split("/").pop()}:${site.lineno} ${site.function}`,
    shapeName(profile),
    profile.fingerprint,
  ];
  return haystack.some((text) => text?.toLowerCase().includes(needle));
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const SORTS: Record<SortKey, (a: ShapeRow, b: ShapeRow) => number> = {
  // Numeric collation, so tpch/q2 comes before tpch/q10.
  name: (a, b) => byName.compare(title(a.runs[0]!), title(b.runs[0]!)),
  runs: (a, b) => a.runs.length - b.runs.length,
  wall: (a, b) => a.wallMs - b.wallMs,
  cpu: (a, b) => a.cpuMs / a.runs.length - b.cpuMs / b.runs.length,
};

/** Shapes in the order asked for; ties keep the most expensive first. */
export function sortShapes(rows: ShapeRow[], sort: Sort): ShapeRow[] {
  const compare = SORTS[sort.key];
  return [...rows].sort((a, b) => (sort.descending ? -1 : 1) * compare(a, b) || b.wallMs - a.wallMs);
}

/** The query shapes to list: grouped, narrowed by the search, and sorted. */
export const visibleShapes = (state: ViewerState): ShapeRow[] =>
  sortShapes(shapes((currentSession(state)?.profiles ?? []).filter((p) => matches(p, state.search))), state.sort);

/** What to call a query: its label, else a name derived from its plan. */
export const title = (profile: Profile): string => profile.label ?? shapeName(profile);

