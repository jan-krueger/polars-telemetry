import { useMemo, useState } from "react";
import type { SharedView } from "../lib/graph";

export type Pane = "logical" | "physical";
export type View = SharedView & { from: Pane };

export interface Channel {
  publish: (view: View) => void;
  subscribe: (listener: (view: View) => void) => () => void;
}

export interface Panes {
  /** The pane shown on its own, or null for both. */
  alone: Pane | null;
  toggleAlone: (pane: Pane) => void;
  /** The pane that started moving both together, or null when they move apart. */
  linked: Pane | null;
  toggleLinked: (pane: Pane) => void;
  views: Channel;
}

/** How the two plan panes share the screen, kept across queries. */
export default function usePanes(): Panes {
  const [alone, setAlone] = useState<Pane | null>(null);
  const [linked, setLinked] = useState<Pane | null>(null);
  const views = useMemo((): Channel => {
    const listeners = new Set<(view: View) => void>();
    return {
      publish: (view) => listeners.forEach((listener) => listener(view)),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
  }, []);
  return {
    alone,
    toggleAlone: (pane) => setAlone((shown) => (shown === pane ? null : pane)),
    linked,
    toggleLinked: (pane) => setLinked((leader) => (leader ? null : pane)),
    views,
  };
}
