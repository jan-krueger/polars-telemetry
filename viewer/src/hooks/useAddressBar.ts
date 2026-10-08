import { useEffect, type Dispatch } from "react";
import { isShareFragment } from "../share/link";
import { fromHash, isNewPage, routeOf, toHash } from "../state/route";
import { currentSession, type Action, type ViewerState } from "../state/viewer";

export default function useAddressBar(state: ViewerState, dispatch: Dispatch<Action>): void {
  const { booted } = state;

  useEffect(() => {
    const back = () => {
      if (!isShareFragment(location.hash)) dispatch({ type: "navigated", route: fromHash(location.hash) });
    };
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, [dispatch]);

  // Replace, not push, when the address named no session: back must not land on a redirect.
  useEffect(() => {
    if (!booted) return;
    const open = currentSession(state);
    if (open?.shared) {
      if (location.hash !== open.shared) history.replaceState(null, "", open.shared);
      return;
    }
    const route = routeOf(state);
    const shown = fromHash(location.hash);
    const hash = toHash(route);
    if (hash === toHash(shown)) return;
    const url = hash || location.pathname + location.search;
    if (shown.sessionId && isNewPage(shown, route)) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }, [booted, state.sessions, state.sessionId, state.queryId, state.node]);
}
