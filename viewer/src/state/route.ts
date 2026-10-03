/**
 * What the address bar holds: the session, query and node on screen, so a
 * reload or the back button returns to them. Session ids are local to this
 * browser, so a link opens the same view only where that session was imported.
 */

import type { NodeRef, ViewerState } from "./viewer";

export interface Route {
  sessionId: string | null;
  queryId: string | null;
  node: NodeRef | null;
}

export const routeOf = (state: ViewerState): Route => ({
  sessionId: state.sessionId,
  queryId: state.queryId,
  node: state.node,
});

/** `#s=<session>&q=<query>&n=physical.12`, or "" for nothing selected. */
export function toHash(route: Route): string {
  if (!route.sessionId) return "";
  const params = new URLSearchParams({ s: route.sessionId });
  if (route.queryId) {
    params.set("q", route.queryId);
    if (route.node) params.set("n", `${route.node.plan}.${route.node.id}`);
  }
  return `#${params}`;
}

export function fromHash(hash: string): Route {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const [plan, id] = (params.get("n") ?? "").split(".");
  const node =
    (plan === "logical" || plan === "physical") && id && /^\d+$/.test(id) ? { plan, id: Number(id) } : null;
  return { sessionId: params.get("s"), queryId: params.get("q"), node } as Route;
}

/**
 * Whether moving from one route to the next deserves a history entry: a
 * different session or query does, a different node does not, or every click
 * in a plan would be one more press of the back button.
 */
export const isNewPage = (from: Route, to: Route): boolean =>
  from.sessionId !== to.sessionId || from.queryId !== to.queryId;
