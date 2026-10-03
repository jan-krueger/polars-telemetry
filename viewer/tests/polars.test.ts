import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { derivedRole, exprColumn, nodeLabel, relationName, roleOf, type RawNode } from "../src/lib/polars";

const profile = JSON.parse(
  readFileSync(new URL("./fixtures/profile.json", import.meta.url), "utf8"),
) as { plan: { physical: RawNode[]; logical: RawNode[] } };

const everyNode = [...profile.plan.physical, ...profile.plan.logical];

describe("roles", () => {
  it("derives the same role the Python dialect wrote, for every node", () => {
    // The fallback for profiles that predate `role` must agree with the source.
    const disagreements = everyNode
      .filter((n) => derivedRole(n) !== n.role)
      .map((n) => `${n.kind}: viewer ${derivedRole(n)} vs dialect ${n.role}`);
    expect(disagreements).toEqual([]);
  });

  it("prefers the role the profile states", () => {
    expect(roleOf({ id: 0, kind: "Filter", role: "join", inputs: [] })).toBe("join");
  });

  it("falls back to deriving the role for an older profile", () => {
    expect(roleOf({ id: 0, kind: "Filter", inputs: [] })).toBe("selection");
    expect(roleOf({ id: 0, kind: "Filter", role: "not-a-role", inputs: [] })).toBe("selection");
  });

  it("reads semi and anti joins out of the IR's how", () => {
    expect(derivedRole({ kind: "Join", properties: { how: "ANTI" } })).toBe("semi_anti_join");
    expect(derivedRole({ kind: "Join", properties: { how: "INNER" } })).toBe("join");
  });

  it("calls a kind it has never seen unknown, without throwing", () => {
    expect(derivedRole({ kind: "HashJoin" })).toBe("unknown");
  });
});

describe("exprColumn", () => {
  it.each([
    ['col("region")', "region"],
    ['col("with \\"quote\\"")', 'with \\"quote\\"'],
    ['col("a").dt.year()', 'col("a").dt.year()'],
    ["lit(5)", "lit(5)"],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(exprColumn(input)).toBe(expected);
  });

  it("never throws on a value that is not a string", () => {
    expect(exprColumn(undefined)).toBe("");
    expect(exprColumn(42)).toBe("42");
  });
});

describe("nodeLabel", () => {
  it("labels every aggregation and join on both plans", () => {
    // The physical GroupBy keeps its keys under key_per_input; it was blank.
    const blank = everyNode
      .filter((n) => ["aggregation", "join"].includes(roleOf(n)))
      .filter((n) => !nodeLabel(n))
      .map((n) => n.kind);
    expect(blank).toEqual([]);
  });

  it("names every scan by its relation, and labels only what the name lacks", () => {
    const scans = everyNode.filter((n) => roleOf(n) === "scan");
    expect(scans.every((n) => relationName(n.properties ?? {}))).toBe(true);
    expect(scans.map(nodeLabel).every((l) => l === "" || l === "pushdown")).toBe(true);
  });
});

describe("the fallback table", () => {
  const dialect = JSON.parse(
    readFileSync(new URL("./fixtures/dialect.json", import.meta.url), "utf8"),
  ) as Record<string, string>;

  it("matches the Python dialect, kind for kind", () => {
    const mismatched = Object.entries(dialect)
      .filter(([kind, role]) => derivedRole({ kind }) !== role)
      .map(([kind, role]) => `${kind}: viewer ${derivedRole({ kind })}, dialect ${role}`);
    expect(mismatched).toEqual([]);
  });
});
