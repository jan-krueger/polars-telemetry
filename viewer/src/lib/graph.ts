// React Flow takes node sizes from the node objects, not the DOM: unsized nodes vanish from the minimap.

import dagre from "@dagrejs/dagre";
import { Position, type Edge, type Node, type NodeHandle } from "@xyflow/react";
import { rows as formatRows } from "./format";
import { nodeAt, type Moment, type NodeState } from "./replay";
import type { Finding, PlanNode } from "../model/profile";
import { badge } from "./insights";

export const NODE_W = 196;
export const NODE_H = 56;
export const EDGE_MIN = 1;
export const EDGE_MAX = 6;

/** Log scale up to the busiest edge. */
export function edgeWidth(rows: number | undefined, busiest: number): number {
  if (!rows || rows < 1 || busiest < 1) return EDGE_MIN;
  return EDGE_MIN + ((EDGE_MAX - EDGE_MIN) * Math.log1p(rows)) / Math.log1p(busiest);
}

export interface Graph {
  nodes: { id: string; width: number; height: number }[];
  edges: [source: string, target: string][];
  /** Left-to-right pairs, in input order. */
  order: [left: string, right: string][];
}

export type Positions = Record<string, { x: number; y: number }>;

export function planGraph(plan: PlanNode[]): Graph {
  const ids = new Set(plan.map((n) => String(n.id)));
  const inputs = plan.map((n) => [...new Set(n.inputs.map(String).filter((i) => ids.has(i)))]);
  return {
    nodes: plan.map((n) => ({ id: String(n.id), width: NODE_W, height: NODE_H })),
    edges: plan.flatMap((n, k) => inputs[k]!.map((i): [string, string] => [i, String(n.id)])),
    order: inputs.flatMap((ins) => ins.slice(1).map((right, k): [string, string] => [ins[k]!, right])),
  };
}

/** Sinks on top, as polars prints plans. Returns top-left corners. */
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

/** Below this zoom text is unreadable, so nodes and edges drop it. */
export const FAR_ZOOM = 0.2;

export function distant(flow: { nodes: Node<FlowData>[]; edges: Edge[] }): { nodes: Node<FlowData>[]; edges: Edge[] } {
  return {
    nodes: flow.nodes.map((n) => ({ ...n, data: { ...n.data, far: true } })),
    edges: flow.edges.map((e) => (e.label === undefined ? e : { ...e, label: undefined })),
  };
}

export const startsFar = (plan: Box, pane = { width: 600, height: 700 }): boolean =>
  Math.min(pane.width / plan.width, pane.height / plan.height) < FAR_ZOOM;

const classes = (...names: (string | false | null | undefined)[]): string | undefined =>
  names.filter(Boolean).join(" ") || undefined;
const isFaded = (className: string | undefined): boolean => !!className?.split(" ").includes("faded");
const unfaded = (className: string | undefined): string | undefined =>
  classes(...(className?.split(" ").filter((c) => c !== "faded") ?? []));

/** Untouched nodes and edges keep their identity. */
export function withSelection(
  flow: { nodes: Node<FlowData>[]; edges: Edge[] },
  selectedId: number | null,
): { nodes: Node<FlowData>[]; edges: Edge[] } {
  if (selectedId === null) return flow;
  const id = String(selectedId);
  if (!flow.nodes.some((n) => n.id === id)) return flow;
  const lit = new Set(flow.nodes.filter((n) => !isFaded(n.className) || n.id === id).map((n) => n.id));
  return {
    nodes: flow.nodes.map((n) => (n.id === id ? { ...n, selected: true, className: unfaded(n.className) } : n)),
    edges: flow.edges.map((e) =>
      e.source === id || e.target === id
        ? lit.has(e.source) && lit.has(e.target)
          ? { ...e, className: unfaded(e.className) }
          : { ...e, className: classes(unfaded(e.className), "faded") }
        : e),
  };
}

export interface Box { x: number; y: number; width: number; height: number }
export interface Viewport { x: number; y: number; zoom: number }
/** A pane's centre as a fraction of the plan's extent, so it carries across plans of any size. */
export interface SharedView { fx: number; fy: number; zoom: number }

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
  far?: boolean;
  finding?: "warn" | "info" | null;
  /** While replaying: whether the node has started or finished at that moment. */
  live?: NodeState;
}

export const cpuMs = (n: PlanNode): number => Number(n.metrics?.total_time_ns ?? 0) / 1e6;

export interface FocusStep {
  /** 0 lights every node. */
  thresholdMs: number;
  /** Percent of the query's CPU time. */
  coverage: number;
  shown: number;
}

/** Each stop drops the cheapest lit nodes; equal costs drop together. */
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

/** The fewest nodes still covering `coverage`, so a focus carries across plans. */
export function stepFor(steps: FocusStep[], coverage: number | null): number {
  if (coverage === null) return 0;
  let chosen = 0;
  steps.forEach((step, index) => {
    if (step.coverage >= coverage - 1e-9) chosen = index;
  });
  return chosen;
}

/** Faster dots for more rows per second: 0.25 s per step at tens of millions, 1.6 s at a thousand. */
export const flowSeconds = (rowsPerSecond: number): number =>
  Math.min(1.6, Math.max(0.25, 1.6 - 0.27 * Math.max(0, Math.log10(rowsPerSecond) - 3)));

const HANDLE = 6;

/** Nodes have a fixed size, so their handles are known up front and never need measuring again when a node's data changes. */
const HANDLES: NodeHandle[] = [
  { type: "target", position: Position.Bottom, x: NODE_W / 2 - HANDLE / 2, y: NODE_H - HANDLE / 2, width: HANDLE, height: HANDLE },
  { type: "source", position: Position.Top, x: NODE_W / 2 - HANDLE / 2, y: -HANDLE / 2, width: HANDLE, height: HANDLE },
];

export function toFlow(
  plan: PlanNode[],
  positions: Positions,
  { logical, selectedId, thresholdMs = 0, findings, moment }:
    { logical: boolean; selectedId: number | null; thresholdMs?: number; findings?: Map<number, Finding[]>; moment?: Moment | null },
): { nodes: Node<FlowData>[]; edges: Edge[] } {
  const shown = moment && !logical ? plan.map((n) => nodeAt(n, moment)) : plan;
  const total = shown.reduce((sum, n) => sum + cpuMs(n), 0) || 1;
  const byId = new Map(shown.map((n) => [n.id, n]));
  // The selected node stays lit so the details never describe a faded node.
  const faded = (n: PlanNode): boolean =>
    !logical && thresholdMs > 0 && n.id !== selectedId && cpuMs(n) < thresholdMs;
  const live = (n: PlanNode): NodeState | undefined =>
    moment && !logical ? (moment.state.get(n.id) ?? "waiting") : undefined;

  const nodes = shown.map((n): Node<FlowData> => ({
    id: String(n.id),
    type: "plan",
    position: positions[String(n.id)] ?? { x: 0, y: 0 },
    width: NODE_W,
    height: NODE_H,
    measured: { width: NODE_W, height: NODE_H },
    handles: HANDLES,
    selected: selectedId === n.id,
    className: classes(faded(n) && "faded", badge(findings?.get(n.id)) && `flag-${badge(findings?.get(n.id))}`),
    data: { node: n, share: (cpuMs(n) / total) * 100, logical, label: n.label, finding: badge(findings?.get(n.id)), live: live(n) },
  }));

  const sent = (n: PlanNode | undefined): number | undefined => {
    const rows = n?.metrics?.rows_sent;
    return typeof rows === "number" ? rows : undefined;
  };
  const busiest = logical ? 0 : Math.max(0, ...shown.map((n) => sent(n) ?? 0));

  const edges = shown.flatMap((n) =>
    n.inputs.flatMap((input): Edge[] => {
      const upstream = byId.get(input);
      if (!upstream) return [];
      const rows = logical ? undefined : sent(upstream);
      const flow = moment?.flow.get(input) ?? 0;
      return [{
        id: `${input}-${n.id}`,
        ...(logical ? {} : { type: "flow", data: flow > 0 ? { rate: 1 / flowSeconds(flow) } : {} }),
        className: classes(faded(upstream) || faded(n) ? "faded" : false, flow > 0 && "flowing"),
        source: String(input),
        target: String(n.id),
        label: rows === undefined ? undefined : `${formatRows(rows)} rows`,
        style: logical
          ? { stroke: "var(--axis)", strokeDasharray: "4 3" }
          : flow > 0
            ? { strokeWidth: Math.max(2.5, edgeWidth(rows, busiest)) }
            : { stroke: "var(--axis)", strokeWidth: edgeWidth(rows, busiest) },
      }];
    }),
  );
  return { nodes, edges };
}
