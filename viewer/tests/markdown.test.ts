import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { planTree, queryMarkdown } from "../src/lib/markdown";
import { readProfile } from "../src/model/read";
import type { Finding, PlanNode } from "../src/model/profile";

const read = readProfile(JSON.parse(readFileSync(new URL("./fixtures/profile.json", import.meta.url), "utf8")));
if ("problem" in read) throw new Error(read.problem);
const base = read.profile;

const node = (id: number, kind: string, inputs: number[], ms: number, rows: number, role = "projection"): PlanNode =>
  ({ id, kind, role, label: "", inputs, properties: {}, custom: [],
     metrics: { total_time_ns: ms * 1e6, rows_sent: rows, rows_received: rows } }) as unknown as PlanNode;

describe("plan tree", () => {
  const plan = [
    node(1, "InMemorySink", [2], 0, 10, "sink"),
    node(2, "EquiJoin", [3, 4], 20, 10),
    node(3, "Filter", [5], 10, 50),
    node(4, "Select", [5], 10, 50),
    node(5, "Multiplexer", [], 60, 100),
  ];

  it("starts at the sink and expands a shared input once", () => {
    const lines = planTree(plan).split("\n");
    expect(lines.map((l) => l.replace(/ {2,}\d.*$/, ""))).toEqual([
      "InMemorySink",
      "└─ EquiJoin",
      "   ├─ Filter",
      "   │  └─ Multiplexer",
      "   └─ Select",
      "      └─ Multiplexer (shared, see above)",
    ]);
    expect(lines[3]).toContain("60 ms · 60.0% · 100 rows");
  });
});

describe("query as Markdown", () => {
  const finding: Finding = {
    rule: "late_filter", kind: "problem", level: "warn", node_id: base.plan.physical[0]!.id, node_kind: "X",
    cpu_share: 0.46, blocked_share: 0, title: "Filter runs after `join`", fix: "filter before the join",
    evidence: [{ name: "rows kept", value: 0.02, unit: "share" }],
  };

  it("carries the figures, the findings with their docs, and the plan", () => {
    const md = queryMarkdown({ ...base, label: "etl|daily", insights: [finding] });
    expect(md).toMatch(/^### etl\|daily/);
    expect(md).toMatch(/^\| Wall time \| Node CPU \|/m);
    expect(md).toContain("- **Warning:** Filter runs after `join` (46% of CPU; rows kept 2%). Fix: filter before the join");
    expect(md).toContain("(https://jan-krueger.github.io/polars-telemetry/insights/#late_filter)");
    expect(md).toContain("```text\n");
  });

  it("adds IO in flight when Polars reported it", () => {
    expect(queryMarkdown(base)).not.toContain("IO in flight");
    const md = queryMarkdown({ ...base, query_metrics: { io_total_active_ns: 1_500_000 } });
    expect(md).toMatch(/\| IO in flight \|/);
    expect(md).toContain("1.5 ms");
  });
});
