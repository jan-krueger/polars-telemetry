import { createContext, useContext, useSyncExternalStore } from "react";
import type { EdgeLive, Live, NodeLive } from "../lib/graph";

/** One plan pane's replayed moment, which each node and edge reads for itself while React Flow's own graph stays put. */
export class LiveStore {
  private live: Live | null = null;
  private readonly listeners = new Set<() => void>();

  current = (): Live | null => this.live;

  set(live: Live | null): void {
    if (live === this.live) return;
    this.live = live;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export const LiveContext = createContext<LiveStore | null>(null);

const nothing = () => () => {};

export function useLiveNode(id: string): NodeLive | undefined {
  const store = useContext(LiveContext);
  return useSyncExternalStore(store?.subscribe ?? nothing, () => store?.current()?.nodes.get(id));
}

export function useLiveEdge(id: string): EdgeLive | undefined {
  const store = useContext(LiveContext);
  return useSyncExternalStore(store?.subscribe ?? nothing, () => store?.current()?.edges.get(id));
}
