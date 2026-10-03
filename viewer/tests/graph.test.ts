import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyView, EDGE_MAX, EDGE_MIN, edgeWidth, extent, focusSteps, shareView, layout, NODE_H, NODE_W, planGraph, stepFor, toFlow, withSelection } from "../src/lib/graph";
import { readProfile } from "../src/model/read";
import type { PlanNode } from "../src/model/profile";

const read = readProfile(JSON.parse(readFileSync(new URL("./fixtures/profile.json", import.meta.url), "utf8")));
if ("problem" in read) throw new Error(read.problem);
const { physical, logical } = read.profile.plan;

const flow = (plan: PlanNode[], isLogical: boolean, selectedId: number | null = null) =>
  toFlow(plan, layout(planGraph(plan)), { logical: isLogical, selectedId });

describe("toFlow", () => {
  it("sizes every node, or the minimap silently leaves it out", () => {
    for (const plan of [physical, logical]) {
      for (const node of flow(plan, plan === logical).nodes) {
        expect(node.width).toBe(NODE_W);
        expect(node.height).toBe(NODE_H);
        expect(Number.isFinite(node.position.x) && Number.isFinite(node.position.y)).toBe(true);
      }
    }
  });

  it("only draws edges between nodes that exist", () => {
    const { nodes, edges } = flow(physical, false);
    const ids = new Set(nodes.map((n) => n.id));
    expect(edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });

  it("skips an input that is not in the plan rather than drawing to nowhere", () => {
    const orphan = { ...physical[0]!, inputs: [...physical[0]!.inputs, 999_999] };
    const { edges } = flow([orphan, ...physical.slice(1)], false);
    expect(edges.some((e) => e.source === "999999")).toBe(false);
  });

  it("labels physical edges with row counts and logical ones not at all", () => {
    expect(flow(physical, false).edges.some((e) => typeof e.label === "string" && e.label.endsWith("rows"))).toBe(true);
    expect(flow(logical, true).edges.every((e) => e.label === undefined)).toBe(true);
  });

  it("draws edges that carry more rows thicker, on a log scale", () => {
    expect(edgeWidth(1_000_000, 1_000_000)).toBe(EDGE_MAX);
    expect(edgeWidth(0, 1_000_000)).toBe(EDGE_MIN);
    expect(edgeWidth(undefined, 1_000_000)).toBe(EDGE_MIN);
    expect(edgeWidth(1_000, 1_000_000)).toBeCloseTo((EDGE_MIN + EDGE_MAX) / 2, 1);
    const widths = flow(physical, false).edges.map((e) => Number(e.style?.strokeWidth));
    expect(Math.max(...widths)).toBe(EDGE_MAX);
    expect(flow(logical, true).edges.every((e) => e.style?.strokeWidth === undefined)).toBe(true);
  });

  it("links two panes by zoom and by how far along each plan they look", () => {
    const pane = { width: 500, height: 700 };
    const short = extent(layout(planGraph(logical)));
    const tall = { ...short, height: short.height * 2 };
    const seen = shareView({ x: -120, y: -300, zoom: 0.8 }, pane, short);
    const followed = applyView(seen, pane, tall);
    expect(followed.zoom).toBe(0.8);
    expect(shareView(followed, pane, tall)).toEqual(expect.objectContaining({ fx: expect.closeTo(seen.fx), fy: expect.closeTo(seen.fy) }));
    expect(applyView(seen, pane, short)).toEqual({ x: expect.closeTo(-120), y: expect.closeTo(-300), zoom: 0.8 });
  });

  it("selects by replacing only the selected node and its edges, so nothing else re-renders", () => {
    const base = toFlow(physical, layout(planGraph(physical)), { logical: false, selectedId: null, thresholdMs: 1e9 });
    const chosen = physical[Math.floor(physical.length / 2)]!;
    const picked = withSelection(base, chosen.id);
    const changed = picked.nodes.filter((n, i) => n !== base.nodes[i]);
    expect(changed.map((n) => n.id)).toEqual([String(chosen.id)]);
    expect(changed[0]).toMatchObject({ selected: true, className: undefined });
    const touching = (e: { source: string; target: string }) => e.source === String(chosen.id) || e.target === String(chosen.id);
    picked.edges.forEach((e, i) => expect(e === base.edges[i]).toBe(!touching(e)));
    expect(picked).toEqual(toFlow(physical, layout(planGraph(physical)), { logical: false, selectedId: chosen.id, thresholdMs: 1e9 }));
  });

  it("marks only the selected node", () => {
    const target = physical[1]!.id;
    const selected = flow(physical, false, target).nodes.filter((n) => n.selected);
    expect(selected.map((n) => n.id)).toEqual([String(target)]);
  });
});

describe("layout", () => {
  it("places every node", () => {
    const graph = planGraph(physical);
    expect(Object.keys(layout(graph)).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
  });

  it("draws a node's inputs left to right in the order it lists them, in both plans", () => {
    const examples = readFileSync(new URL("../../examples/tpch-sf1.jsonl", import.meta.url), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const reversed: string[] = [];
    for (const document of examples) {
      for (const side of ["logical", "physical"] as const) {
        const plan: PlanNode[] = document.plan[side];
        const parents = new Map<number, number>();
        for (const n of plan) for (const i of new Set(n.inputs)) parents.set(i, (parents.get(i) ?? 0) + 1);
        const positions = layout(planGraph(plan));
        for (const n of plan) {
          const [left, right] = n.inputs;
          if (n.inputs.length !== 2 || left === right || [left, right].some((i) => parents.get(i!)! > 1)) continue;
          if (positions[left!]!.x > positions[right!]!.x) reversed.push(`${document.label} ${side} ${n.kind}`);
        }
      }
    }
    expect(reversed).toEqual([]);
  });

  it("puts sinks above the sources they read from", () => {
    const positions = layout(planGraph(physical));
    const sink = physical.find((n) => n.role === "sink")!;
    const scan = physical.find((n) => n.role === "scan")!;
    expect(positions[String(sink.id)]!.y).toBeLessThan(positions[String(scan.id)]!.y);
  });
});

describe("focus", () => {
  // A chain scan(1) -> filter(2) -> project(3) -> sink(4), costing 80, 15, 5
  // and 0 of 100 ms.
  const node = (id: number, kind: string, ms: number, inputs: number[]): PlanNode =>
    ({ id, kind, role: "selection", label: "", properties: {}, inputs,
       metrics: { total_time_ns: ms * 1e6 } }) as unknown as PlanNode;
  const chain = [node(1, "Scan", 80, []), node(2, "Filter", 15, [1]), node(3, "Project", 5, [2]),
                 node(4, "Sink", 0, [3])];
  const at = (thresholdMs: number, selectedId: number | null = null, logical = false) =>
    toFlow(chain, layout(planGraph(chain)), { logical, selectedId, thresholdMs });
  const fadedNodes = (flow: ReturnType<typeof at>) => flow.nodes.filter((n) => n.className === "faded").map((n) => n.id);
  const fadedEdges = (flow: ReturnType<typeof at>) => flow.edges.filter((e) => e.className === "faded").map((e) => e.id);

  it("steps from every node to the most expensive one, one cost at a time", () => {
    expect(focusSteps(chain).map((s) => [s.shown, Math.round(s.coverage), s.thresholdMs])).toEqual([
      [4, 100, 0],
      [3, 100, 5],
      [2, 95, 15],
      [1, 80, 80],
    ]);
  });

  it("moves nodes that cost the same together", () => {
    const tied = [node(1, "A", 40, []), node(2, "B", 40, [1]), node(3, "C", 20, [2])];
    expect(focusSteps(tied).map((s) => s.shown)).toEqual([3, 2]);
  });

  it("offers no steps for a plan without times", () => {
    expect(focusSteps(chain.map((n) => ({ ...n, metrics: null })))).toHaveLength(1);
  });

  it("keeps a focus across plans as a share of CPU time", () => {
    const steps = focusSteps(chain);
    expect(stepFor(steps, null)).toBe(0);
    expect(stepFor(steps, 95)).toBe(2);
    expect(stepFor(steps, 90)).toBe(2);
    expect(stepFor(steps, 50)).toBe(3);
  });

  it("fades nothing at zero", () => {
    expect(fadedNodes(at(0))).toEqual([]);
    expect(fadedEdges(at(0))).toEqual([]);
  });

  it("fades nodes under the threshold, and every edge touching one", () => {
    const flow = at(15);
    expect(fadedNodes(flow)).toEqual(["3", "4"]);
    expect(fadedEdges(flow)).toEqual(["2-3", "3-4"]);
  });

  it("keeps the selected node lit", () => {
    expect(fadedNodes(at(80, 4))).toEqual(["2", "3"]);
  });

  it("never fades the logical plan, which has no times", () => {
    expect(fadedNodes(at(80, null, true))).toEqual([]);
  });
});

describe("focus on a plan without usable times", () => {
  it("offers only the step that lights every node", () => {
    const plan = [{ id: 1, kind: "Scan", role: "scan", label: "", properties: {}, inputs: [], metrics: { total_time_ns: Number.NaN } }] as unknown as PlanNode[];
    expect(focusSteps(plan)).toHaveLength(1);
  });
});
