import { describe, expect, it } from "vitest";
import { layoutKey, recall, remember } from "../src/lib/layouts";
import type { Graph } from "../src/lib/graph";

const graph = (edges: [string, string][]): Graph => ({
  nodes: ["1", "2", "3"].map((id) => ({ id, width: 196, height: 56 })),
  edges,
  order: [],
});

describe("layout cache", () => {
  it("keys a plan by its structure, so the same shape is laid out once", () => {
    expect(layoutKey(graph([["1", "2"]]))).toBe(layoutKey(graph([["1", "2"]])));
    expect(layoutKey(graph([["1", "2"]]))).not.toBe(layoutKey(graph([["1", "3"]])));
  });

  it("returns what it remembered and forgets the least recently used first", () => {
    const first = { "1": { x: 0, y: 0 } };
    remember("first", first);
    for (let i = 0; i < 31; i++) remember(`other-${i}`, {});
    expect(recall("first")).toBe(first);
    remember("one-more", {});
    expect(recall("first")).toBe(first);
    expect(recall("other-0")).toBeUndefined();
  });
});
