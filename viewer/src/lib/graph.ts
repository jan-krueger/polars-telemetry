/**
 * A plan as a graph: laid out, then shaped for React Flow.
 *
 * Two seams. `layout` sees only a neutral graph, so replacing dagre (with elk,
 * say) changes that one function. `toFlow` is pure, so what React Flow is
 * handed is testable without a DOM — which is where the minimap bug lived:
 * React Flow reads node dimensions off the objects it is given, never the
 * measured DOM, so an unsized node silently vanished from the minimap.
 */

import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";
import { rows as formatRows } from "./format";
import type { PlanNode } from "../model/profile";

export const NODE_W = 196;
export const NODE_H = 56;

export interface Graph {
  nodes: { id: string; width: number; height: number }[];
  edges: [source: string, target: string][];
}

export type Positions = Record<string, { x: number; y: number }>;

/** The plan's nodes, and an edge for every input that exists in it. */
export function planGraph(plan: PlanNode[]): Graph {
  const ids = new Set(plan.map((n) => String(n.id)));
  return {
    nodes: plan.map((n) => ({ id: String(n.id), width: NODE_W, height: NODE_H })),
    edges: plan.flatMap((n) =>
      n.inputs.filter((i) => ids.has(String(i))).map((i): [string, string] => [String(i), String(n.id)]),
    ),
  };
}

/** Layered placement, sinks at the top and sources at the bottom as polars
 *  prints its plans. Top-left corners, as React Flow positions nodes. */
export function layout(graph: Graph): Positions {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "BT", nodesep: 28, ranksep: 46, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const [source, target] of graph.edges) g.setEdge(source, target);
  dagre.layout(g);

  const positions: Positions = {};
  for (const n of graph.nodes) {
    const placed = g.node(n.id);
    positions[n.id] = { x: placed.x - n.width / 2, y: placed.y - n.height / 2 };
  }
  return positions;
}

export interface FlowData extends Record<string, unknown> {
  node: PlanNode;
  share: number;
  logical: boolean;
  label: string;
}

const cpuMs = (n: PlanNode): number => Number(n.metrics?.total_time_ns ?? 0) / 1e6;

/** React Flow's nodes and edges for a laid-out plan. */
export function toFlow(
  plan: PlanNode[],
  positions: Positions,
  { logical, selectedId }: { logical: boolean; selectedId: number | null },
): { nodes: Node<FlowData>[]; edges: Edge[] } {
  const total = plan.reduce((sum, n) => sum + cpuMs(n), 0) || 1;
  const byId = new Map(plan.map((n) => [n.id, n]));

  const nodes = plan.map((n): Node<FlowData> => ({
    id: String(n.id),
    type: "plan",
    position: positions[String(n.id)] ?? { x: 0, y: 0 },
    width: NODE_W,
    height: NODE_H,
    selected: selectedId === n.id,
    data: { node: n, share: (cpuMs(n) / total) * 100, logical, label: n.label },
  }));

  const edges = plan.flatMap((n) =>
    n.inputs.flatMap((input): Edge[] => {
      const upstream = byId.get(input);
      if (!upstream) return [];
      // The logical plan has no counters, so no row counts to put on edges.
      const rows = logical ? undefined : upstream.metrics?.rows_sent;
      return [{
        id: `${input}-${n.id}`,
        source: String(input),
        target: String(n.id),
        label: typeof rows === "number" ? `${formatRows(rows)} rows` : undefined,
        style: logical ? { stroke: "var(--axis)", strokeDasharray: "4 3" } : { stroke: "var(--axis)" },
      }];
    }),
  );
  return { nodes, edges };
}
