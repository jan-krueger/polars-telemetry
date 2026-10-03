import { useEffect, useMemo, useState } from "react";
import { layout, planGraph } from "../lib/graph";
import { SYNC_LAYOUT_MAX, layoutKey, recall, remember } from "../lib/layouts";
import LayoutWorker from "../lib/layout.worker?worker&inline";

/** The plan's positions: at once when small or seen before, otherwise from a worker, null meanwhile. */
export default function useLayout(plan) {
  const graph = useMemo(() => planGraph(plan), [plan]);
  const key = useMemo(() => layoutKey(graph), [graph]);
  const ready = useMemo(
    () => recall(key) ?? (graph.nodes.length <= SYNC_LAYOUT_MAX ? remember(key, layout(graph)) : null),
    [key, graph],
  );
  const [late, setLate] = useState(null);

  useEffect(() => {
    if (ready) return;
    let worker;
    try {
      worker = new LayoutWorker();
    } catch {
      setLate({ key, positions: remember(key, layout(graph)) });
      return;
    }
    worker.onmessage = (event) => setLate({ key, positions: remember(key, event.data) });
    worker.onerror = () => setLate({ key, positions: remember(key, layout(graph)) });
    worker.postMessage(graph);
    return () => worker.terminate();
  }, [key, graph, ready]);

  return ready ?? (late?.key === key ? late.positions : null);
}
