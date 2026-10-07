/**
 * Everything the viewer is showing, and every way it can change.
 *
 * Selection is by `query_id` and session id, never by position, so reordering
 * or filtering a list cannot make it point at a different query. Each action
 * states once what it resets; before, six call sites each cleared their own
 * subset and two of them missed some.
 */

import type { PlanNode, Profile, Session, SessionInfo } from "../model/profile";
import { shapeName } from "../lib/format";
import { cpuMs } from "../lib/graph";
import { basename } from "../lib/polars";
import type { Route } from "./route";

export interface NodeRef {
  plan: "logical" | "physical";
  id: number;
}

export interface ViewerState {
  booted: boolean;
  sessions: Session[];
  /** The page listing every session is open instead of a session's queries. */
  browsing: boolean;
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
  | { type: "stored"; sessions: Session[] }
  | { type: "imported"; sessions: Session[] }
  | { type: "read"; sessionId: string; profiles: Profile[]; raw: unknown[]; forgetOthers: boolean }
  | { type: "opened"; sessionId: string; at: number }
  | { type: "browsed"; open: boolean }
  | { type: "removed"; sessionIds: string[] }
  | { type: "kept"; sessionId: string }
  | { type: "renamed"; sessionId: string; name: string }
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
  browsing: false,
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
      const sessions = recent(action.sessions);
      return { ...state, ...nothingSelected, booted: true, sessions, sessionId: sessions[0]?.id ?? null };
    }
    case "stored": {
      // Storage opened after the page did: add what it holds, keep what is open.
      const known = new Set(state.sessions.map((s) => s.id));
      const sessions = recent([...state.sessions, ...action.sessions.filter((s) => !known.has(s.id))]);
      return { ...state, sessions, sessionId: state.sessionId ?? sessions[0]?.id ?? null };
    }
    case "imported":
      if (!action.sessions.length) return state;
      return {
        ...state,
        ...nothingSelected,
        browsing: false,
        sessions: [...action.sessions, ...state.sessions],
        sessionId: action.sessions[0]!.id,
      };
    case "read": {
      // Only the open session is kept in memory; the others are read again
      // from storage when opened. Link sessions have nowhere to come from.
      const sessions = state.sessions.map((s) => {
        if (s.id === action.sessionId) return { ...s, profiles: action.profiles, raw: action.raw };
        return action.forgetOthers && !s.shared ? { ...s, profiles: null, raw: null } : s;
      });
      const next = { ...state, sessions };
      if (state.sessionId !== action.sessionId) return next;
      return reducer(next, { type: "navigated", route: { sessionId: state.sessionId, queryId: state.queryId, node: state.node } });
    }
    case "opened":
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.id === action.sessionId ? { ...s, openedAt: action.at } : s)),
      };
    case "browsed":
      return { ...state, browsing: action.open };
    case "removed": {
      const gone = new Set(action.sessionIds);
      const sessions = state.sessions.filter((s) => !gone.has(s.id));
      if (!state.sessionId || !gone.has(state.sessionId)) return { ...state, sessions };
      return { ...state, ...nothingSelected, sessions, sessionId: recent(sessions)[0]?.id ?? null };
    }
    case "renamed":
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.id === action.sessionId ? { ...s, name: action.name } : s)),
      };
    case "kept":
      return {
        ...state,
        sessions: state.sessions.map((s) => (s.id === action.sessionId ? { ...s, shared: undefined } : s)),
      };
    case "cleared":
      return { ...state, ...nothingSelected, sessions: [], sessionId: null };
    case "sessionPicked":
      return { ...state, ...nothingSelected, browsing: false, sessionId: action.sessionId };
    case "queryPicked": {
      const profile = findProfile(currentSession(state), action.queryId);
      return { ...state, browsing: false, queryId: action.queryId, compareId: null, node: profile ? hottest(profile) : null };
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
      // Not read yet: keep what the link asks for until the profiles arrive.
      if (session && !session.profiles) {
        return { ...state, ...nothingSelected, browsing: false, sessionId: session.id, queryId: route.queryId, node: route.node };
      }
      const profile = findProfile(session, route.queryId);
      const node = profile && route.node && findNode(profile, route.node) ? route.node : profile && hottest(profile);
      return {
        ...state,
        ...nothingSelected,
        browsing: false,
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

/** The session already holding exactly these runs, so a file opened twice is not stored twice. */
export function sameRuns(sessions: SessionInfo[], profiles: Profile[]): SessionInfo | null {
  const key = (ids: string[]) => [...ids].sort().join(",");
  const wanted = key(profiles.map((p) => p.query_id));
  return sessions.find((s) => s.runIds.length === profiles.length && key(s.runIds) === wanted) ?? null;
}

/** Most recently opened first; a session never opened counts from its import. */
export const recent = <S extends SessionInfo>(sessions: S[]): S[] =>
  [...sessions].sort((a, b) => (b.openedAt ?? b.importedAt) - (a.openedAt ?? a.importedAt));

export const currentSession = (state: ViewerState): Session | null =>
  state.sessions.find((s) => s.id === state.sessionId) ?? null;

const findProfile = (session: Session | null, queryId: string | null): Profile | null =>
  (queryId && session?.profiles?.find((p) => p.query_id === queryId)) || null;

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
    if (!node.metrics) continue;
    if (!best || cpuMs(node) > cpuMs(best)) best = node;
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
    site && `${basename(site.filepath)}:${site.lineno} ${site.function}`,
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

/** The label path every query shares, such as "pipeline/", so a list can show what differs. */
export function sharedPrefix(profiles: Profile[]): string {
  if (profiles.length < 2) return "";
  const paths = profiles.map((p) => title(p).split("/"));
  const shared: string[] = [];
  for (let i = 0; i < Math.min(...paths.map((p) => p.length - 1)); i++) {
    const segment = paths[0]![i]!;
    if (!paths.every((p) => p[i] === segment)) break;
    shared.push(segment);
  }
  return shared.length ? `${shared.join("/")}/` : "";
}

