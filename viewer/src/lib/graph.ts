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
export const EDGE_MIN = 1;
export const EDGE_MAX = 6;

/** Stroke width for an edge carrying `rows`, on a log scale up to the plan's busiest edge. */
export function edgeWidth(rows: number | undefined, busiest: number): number {
  if (!rows || rows < 1 || busiest < 1) return EDGE_MIN;
  return EDGE_MIN + ((EDGE_MAX - EDGE_MIN) * Math.log1p(rows)) / Math.log1p(busiest);
}

export interface Graph {
  nodes: { id: string; width: number; height: number }[];
  edges: [source: string, target: string][];
  /** Pairs to draw left of each other, as a node lists its inputs. */
  order: [left: string, right: string][];
}

export type Positions = Record<string, { x: number; y: number }>;

/** The plan's nodes, and an edge for every input that exists in it. */
export function planGraph(plan: PlanNode[]): Graph {
  const ids = new Set(plan.map((n) => String(n.id)));
  const inputs = plan.map((n) => [...new Set(n.inputs.map(String).filter((i) => ids.has(i)))]);
  return {
    nodes: plan.map((n) => ({ id: String(n.id), width: NODE_W, height: NODE_H })),
    edges: plan.flatMap((n, k) => inputs[k]!.map((i): [string, string] => [i, String(n.id)])),
    order: inputs.flatMap((ins) => ins.slice(1).map((right, k): [string, string] => [ins[k]!, right])),
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
  dagre.layout(g, { constraints: graph.order.map(([left, right]) => ({ left, right })) });

  const positions: Positions = {};
  for (const n of graph.nodes) {
    const placed = g.node(n.id);
    positions[n.id] = { x: placed.x - n.width / 2, y: placed.y - n.height / 2 };
  }
  return positions;
}

export interface Box { x: number; y: number; width: number; height: number }
export interface Viewport { x: number; y: number; zoom: number }
/** Where a pane looks, independent of the plan's size: its centre as a fraction of the plan's extent. */
export interface SharedView { fx: number; fy: number; zoom: number }

/** The area every node of a laid-out plan covers. */
export function extent(positions: Positions): Box {
  const placed = Object.values(positions);
  if (!placed.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...placed.map((p) => p.x));
  const y = Math.min(...placed.map((p) => p.y));
  return {
    x, y,
    width: Math.max(...placed.map((p) => p.x)) + NODE_W - x,
    height: Math.max(...placed.map((p) => p.y)) + NODE_H - y,
  };
}

export function shareView(viewport: Viewport, pane: { width: number; height: number }, plan: Box): SharedView {
  const cx = (pane.width / 2 - viewport.x) / viewport.zoom;
  const cy = (pane.height / 2 - viewport.y) / viewport.zoom;
  return { fx: (cx - plan.x) / plan.width, fy: (cy - plan.y) / plan.height, zoom: viewport.zoom };
}

export function applyView(view: SharedView, pane: { width: number; height: number }, plan: Box): Viewport {
  const cx = plan.x + view.fx * plan.width;
  const cy = plan.y + view.fy * plan.height;
  return { x: pane.width / 2 - cx * view.zoom, y: pane.height / 2 - cy * view.zoom, zoom: view.zoom };
}

export interface FlowData extends Record<string, unknown> {
  node: PlanNode;
  share: number;
  logical: boolean;
  label: string;
}

/** A node's own CPU time in milliseconds; 0 without counters. */
export const cpuMs = (n: PlanNode): number => Number(n.metrics?.total_time_ns ?? 0) / 1e6;

export interface FocusStep {
  /** Nodes costing at least this much CPU time stay lit; 0 lights every node. */
  thresholdMs: number;
  /** Their share of the query's CPU time, in percent. */
  coverage: number;
  /** How many nodes that is. */
  shown: number;
}

/**
 * The focus slider's stops for one plan. The first lights every node; each
 * one after it takes away the cheapest nodes still lit, so the last lights
 * only the most expensive. Nodes that cost the same come and go together.
 */
export function focusSteps(plan: PlanNode[]): FocusStep[] {
  const all: FocusStep = { thresholdMs: 0, coverage: 100, shown: plan.length };
  const total = plan.reduce((sum, n) => sum + cpuMs(n), 0);
  if (total <= 0) return [all];

  const costs = [...new Set(plan.map(cpuMs).filter((ms) => ms > 0))].sort((a, b) => b - a);
  const steps: FocusStep[] = [];
  for (const thresholdMs of costs) {
    const lit = plan.filter((n) => cpuMs(n) >= thresholdMs);
    const covered = lit.reduce((sum, n) => sum + cpuMs(n), 0);
    steps.push({ thresholdMs, coverage: (covered / total) * 100, shown: lit.length });
  }
  if (!steps.length) return [all];
  steps.reverse();
  return steps[0]!.shown === plan.length ? [all, ...steps.slice(1)] : [all, ...steps];
}

/**
 * The step that keeps a focus when moving to another plan: the fewest nodes
 * still covering at least as much of its CPU time. Null focus lights all.
 */
export function stepFor(steps: FocusStep[], coverage: number | null): number {
  if (coverage === null) return 0;
  let chosen = 0;
  steps.forEach((step, index) => {
    if (step.coverage >= coverage - 1e-9) chosen = index;
  });
  return chosen;
}

/** React Flow's nodes and edges for a laid-out plan. */
export function toFlow(
  plan: PlanNode[],
  positions: Positions,
  { logical, selectedId, thresholdMs = 0 }: { logical: boolean; selectedId: number | null; thresholdMs?: number },
): { nodes: Node<FlowData>[]; edges: Edge[] } {
  const total = plan.reduce((sum, n) => sum + cpuMs(n), 0) || 1;
  const byId = new Map(plan.map((n) => [n.id, n]));
  // The logical plan has no times to focus on. The selected node stays lit,
  // so the details beside the plan never describe a node that has faded.
  const faded = (n: PlanNode): boolean =>
    !logical && thresholdMs > 0 && n.id !== selectedId && cpuMs(n) < thresholdMs;

  const nodes = plan.map((n): Node<FlowData> => ({
    id: String(n.id),
    type: "plan",
    position: positions[String(n.id)] ?? { x: 0, y: 0 },
    width: NODE_W,
    height: NODE_H,
    selected: selectedId === n.id,
    className: faded(n) ? "faded" : undefined,
    data: { node: n, share: (cpuMs(n) / total) * 100, logical, label: n.label },
  }));

  const sent = (n: PlanNode | undefined): number | undefined => {
    const rows = n?.metrics?.rows_sent;
    return typeof rows === "number" ? rows : undefined;
  };
  const busiest = logical ? 0 : Math.max(0, ...plan.map((n) => sent(n) ?? 0));

  const edges = plan.flatMap((n) =>
    n.inputs.flatMap((input): Edge[] => {
      const upstream = byId.get(input);
      if (!upstream) return [];
      // The logical plan has no counters, so no row counts to put on edges.
      const rows = logical ? undefined : sent(upstream);
      return [{
        id: `${input}-${n.id}`,
        // An edge stays lit only between two lit nodes.
        className: faded(upstream) || faded(n) ? "faded" : undefined,
        source: String(input),
        target: String(n.id),
        label: rows === undefined ? undefined : `${formatRows(rows)} rows`,
        style: logical
          ? { stroke: "var(--axis)", strokeDasharray: "4 3" }
          : { stroke: "var(--axis)", strokeWidth: edgeWidth(rows, busiest) },
      }];
    }),
  );
  return { nodes, edges };
}
