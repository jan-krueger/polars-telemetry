import type { Graph, Positions } from "./graph";

export const SYNC_LAYOUT_MAX = 250;
const KEEP = 32;

const laidOut = new Map<string, Positions>();

export const layoutKey = (graph: Graph): string =>
  JSON.stringify([graph.nodes.map((n) => [n.id, n.width, n.height]), graph.edges, graph.order]);

export function recall(key: string): Positions | undefined {
  const positions = laidOut.get(key);
  if (positions) {
    laidOut.delete(key);
    laidOut.set(key, positions);
  }
  return positions;
}

export function remember(key: string, positions: Positions): Positions {
  laidOut.delete(key);
  laidOut.set(key, positions);
  while (laidOut.size > KEEP) laidOut.delete(laidOut.keys().next().value!);
  return positions;
}
