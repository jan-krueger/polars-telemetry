import dagre from "@dagrejs/dagre";

export const NODE_W = 196;
export const NODE_H = 56;

/** Lay the plan out with dagre: proper layered placement with crossing
 *  reduction. Sinks at the top, sources at the bottom, matching polars' own
 *  plan rendering. */
export function layout(planNodes) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "BT", nodesep: 28, ranksep: 46, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of planNodes) g.setNode(String(n.id), { width: NODE_W, height: NODE_H });
  for (const n of planNodes)
    for (const input of n.inputs) {
      if (planNodes.some((m) => m.id === input)) g.setEdge(String(input), String(n.id));
    }
  dagre.layout(g);

  const positions = {};
  for (const n of planNodes) {
    const p = g.node(String(n.id));
    positions[n.id] = { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
  }
  return positions;
}
