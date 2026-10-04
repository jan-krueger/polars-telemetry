import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { busy, compact, diagnostics, joinGrowth, shapeName, span } from "../src/lib/format.js";

const profile = (over = {}) => ({
  schema: "polars-telemetry/profile@1",
  plan: { physical: [{ id: 0, inputs: [] }], logical: [{ id: 0, inputs: [] }] },
  ...over,
});

describe("shapeName", () => {
  it("never throws on a profile that passed validation", () => {
    expect(() => shapeName(profile())).not.toThrow();
  });
});

describe("diagnostics", () => {
  it("renders nothing when the profile carries none", () => {
    expect(diagnostics({})).toEqual([]);
  });

  it("leaves parallel efficiency to the threads-busy bar", () => {
    expect(diagnostics({ diagnostics: { parallel_efficiency: 0.2, cpu_count: 8 } })).toEqual([]);
  });
});

describe("busy", () => {
  it("reads CPU over wall as threads busy, judged against the threads polars had", () => {
    const b = busy({ wall_ms: 100, cpu_ms: 570, diagnostics: { cpu_count: 48 } });
    expect(b.threads).toBeCloseTo(5.7);
    expect(b.verdict).toBe("crit");
    expect(busy({ wall_ms: 100, cpu_ms: 760, diagnostics: { cpu_count: 8 } }).verdict).toBe("good");
  });

  it("still counts threads when the profile does not say how many there were", () => {
    expect(busy({ wall_ms: 10, cpu_ms: 30, diagnostics: {} })).toMatchObject({ of: null, share: null });
    expect(busy({ wall_ms: 10, cpu_ms: 0 })).toBeNull();
  });
});

describe("human units", () => {
  it("scales durations and counts", () => {
    expect([span(5.25), span(940), span(88_906.5), span(456_000), span(781_494)]).toEqual(["5.3 ms", "940 ms", "88.9 s", "456 s", "13.0 min"]);
    expect([compact(940), compact(12_345), compact(301_000), compact(57_718_060)]).toEqual(["940", "12,345", "301K", "57.7M"]);
  });
});

describe("shapeName, contents", () => {
  it("names the first table read, without counting joins or listing keys", () => {
    const p = {
      plan: {
        physical: [],
        logical: [
          { id: 3, kind: "GroupBy", role: "aggregation", inputs: [0], properties: { keys: ["col(\"n_name\")"] } },
          { id: 0, kind: "Join", role: "join", inputs: [1, 2], properties: {} },
          { id: 1, kind: "Scan", role: "scan", inputs: [], properties: { first_source: "/d/part.parquet" } },
          { id: 2, kind: "Scan", role: "scan", inputs: [], properties: { first_source: "/d/lineitem.parquet" } },
        ],
      },
    };
    expect(shapeName(p)).toBe("part.parquet");
  });
});

describe("join growth", () => {
  const node = (id, kind, inputs, rows) => ({ id, kind, inputs, metrics: { rows_sent: rows } });

  it("compares a join with its larger input, so a small table joined to a big one is no explosion", () => {
    expect(joinGrowth([node(1, "MultiScan", [], 100), node(2, "MultiScan", [], 1_000_000), node(3, "EquiJoin", [1, 2], 1_000_000)])).toBe(1);
    expect(joinGrowth([node(1, "MultiScan", [], 2_000), node(2, "MultiScan", [], 1_000), node(3, "EquiJoin", [1, 2], 10_000)])).toBe(5);
  });

  it("counts a shared input once per consumer", () => {
    const plan = [node(1, "MultiScan", [], 10), node(2, "Multiplexer", [], 4_000), node(3, "EquiJoin", [1, 2], 1_000),
      node(4, "Select", [2], 1_000), node(5, "Select", [2], 1_000), node(6, "Select", [2], 1_000)];
    expect(joinGrowth(plan)).toBe(1);
  });

  it("is computed for profiles that predate it, and never shown from the deprecated amplification", () => {
    const old = { diagnostics: { join_amplification: 54 }, plan: { physical: [node(1, "MultiScan", [], 110_001), node(2, "MultiScan", [], 54), node(3, "CrossJoin", [1, 2], 5_940_054)] } };
    const chips = diagnostics(old);
    expect(chips.map((c) => c.k)).toEqual(["join_growth"]);
    expect(chips[0]).toMatchObject({ v: "54.00", s: "crit" });
  });
});

describe("join growth parity", () => {
  it("computes in the viewer what the exporter wrote", () => {
    const document = JSON.parse(readFileSync(new URL("./fixtures/profile.json", import.meta.url), "utf8"));
    expect(joinGrowth(document.plan.physical)).toBeCloseTo(document.diagnostics.join_growth, 9);
  });
});

describe("join growth on healthy plans", () => {
  it("stays at or below 2 for every TPC-H query, where the deprecated amplification flagged q9 as fan-out", () => {
    const lines = readFileSync(new URL("../../examples/tpch-sf1.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
    const worst = Math.max(...lines.map((line) => joinGrowth(JSON.parse(line).plan.physical) ?? 0));
    expect(worst).toBeLessThanOrEqual(2);
  });
});
