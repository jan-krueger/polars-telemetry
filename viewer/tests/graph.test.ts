import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { focusSteps, layout, NODE_H, NODE_W, planGraph, stepFor, toFlow } from "../src/lib/graph";
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
