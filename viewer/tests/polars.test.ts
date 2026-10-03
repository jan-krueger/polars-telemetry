import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { basename, chainLines, conjunction, exprLines, derivedRole, exprColumn, nodeLabel, relationName, roleOf, type RawNode } from "../src/lib/polars";

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

describe("chainLines", () => {
  it("leaves a short expression on one line", () => {
    expect(chainLines('col("a").sum()')).toEqual(['col("a").sum()']);
  });

  it("puts each method call of a long chain on its own line", () => {
    expect(chainLines('col("_POLARS_TMP_2").sum().alias("_POLARS_TMP_3")')).toEqual([
      'col("_POLARS_TMP_2")', "  .sum()", '  .alias("_POLARS_TMP_3")',
    ]);
  });

  it("keeps a namespace with its method", () => {
    expect(chainLines('col("placed_at").dt.year().alias("year_of_placement")')).toEqual([
      'col("placed_at")', "  .dt.year()", '  .alias("year_of_placement")',
    ]);
  });

  it("never breaks inside a nested expression or a string", () => {
    const expr = 'col("amount").filter(col("a.b").gt(lit(1)).and(col("c"))).sum()';
    const lines = chainLines(expr);
    expect(lines).toEqual(['col("amount")', '  .filter(col("a.b").gt(lit(1)).and(col("c")))', "  .sum()"]);
  });

  it("loses no characters", () => {
    const expr = 'col("x").cast(Int64).fill_null(0).alias("a long alias name")';
    expect(chainLines(expr).map((l) => l.replace(/^  /, "")).join("")).toBe(expr);
  });
});

describe("exprLines", () => {
  it("leaves a short condition as written", () => {
    expect(exprLines('col("l_shipdate") <= 1998-09-02')).toEqual(['col("l_shipdate") <= 1998-09-02']);
  });

  it("puts each condition of a long & on its own line, without polars' pair parentheses", () => {
    expect(exprLines('((col("a") == 1) & col("b").is_between([1, 11])) & col("c").is_null()')).toEqual([
      '  col("a") == 1',
      '& col("b").is_between([1, 11])',
      '& col("c").is_null()',
    ]);
  });

  it("keeps the parentheses that group & under |", () => {
    const lines = exprLines(
      '(((col("p_brand") == "Brand#12") & col("p_size").is_between([1, 5])) | ' +
        '((col("p_brand") == "Brand#23") & col("p_size").is_between([1, 10])))',
    );
    expect(lines).toEqual([
      '  ( col("p_brand") == "Brand#12"',
      '  & col("p_size").is_between([1, 5]))',
      '| ( col("p_brand") == "Brand#23"',
      '  & col("p_size").is_between([1, 10]))',
    ]);
  });

  it("does not split at an operator inside a string or a call", () => {
    expect(exprLines('(col("a") == "x & y") & (col("b") | col("c"))')).toEqual([
      '  col("a") == "x & y"',
      '& (col("b") | col("c"))',
    ]);
  });

  it("still breaks a long method chain", () => {
    expect(exprLines('col("_POLARS_TMP_2").sum().alias("_POLARS_TMP_3")')).toEqual(
      chainLines('col("_POLARS_TMP_2").sum().alias("_POLARS_TMP_3")'),
    );
  });
});

describe("exprLines on large or unusual predicates", () => {
  it("lays out thousands of nested conditions, one per line", () => {
    let predicate = 'col("c0") == 0';
    for (let i = 1; i < 5000; i++) predicate = `(${predicate}) | (col("c${i}") == ${i})`;
    expect(exprLines(predicate)).toHaveLength(5000);
  });

  it("is not thrown off by a string that ends in a backslash", () => {
    expect(exprLines('(col("path") == "C:\\\\Users\\\\") | (col("email") == "alice@example.com")')).toEqual([
      '  col("path") == "C:\\\\Users\\\\"',
      '| col("email") == "alice@example.com"',
    ]);
  });
});

describe("basename", () => {
  it("takes a file name from paths written on any system", () => {
    expect(basename("/srv/data/orders.parquet")).toBe("orders.parquet");
    expect(basename("C:\\data\\orders.parquet")).toBe("orders.parquet");
    expect(relationName({ first_source: "C:\\data\\orders.parquet" })).toBe("orders.parquet");
  });
});

describe("predicates", () => {
  it("lay out the logical plan's separate conditions as the physical plan's single predicate", () => {
    const examples = readFileSync(new URL("../../examples/tpch-sf1.jsonl", import.meta.url), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let compared = 0;
    for (const document of examples) {
      for (const scan of document.plan.logical.filter((n: RawNode) => n.kind === "Scan" && n.properties?.predicate)) {
        const twin = document.plan.physical.find((n: RawNode) =>
          n.kind === "MultiScan" && n.properties?.predicate && n.properties.first_source === scan.properties.first_source);
        if (!twin) continue;
        expect(exprLines(conjunction(scan.properties.predicate))).toEqual(exprLines(twin.properties.predicate));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(90);
  });

  it("leave a single condition as it is", () => {
    expect(conjunction(['col("a") | col("b")'])).toBe('col("a") | col("b")');
  });
});
