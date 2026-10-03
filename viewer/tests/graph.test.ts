import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layout, NODE_H, NODE_W, planGraph, toFlow } from "../src/lib/graph";
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
