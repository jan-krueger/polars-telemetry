import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readJsonl, readProfile, readSession, toJsonl } from "../src/model/read";
import type { Profile } from "../src/model/profile";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/profile.json", import.meta.url), "utf8"));

const minimal = (over: Record<string, unknown> = {}) => ({
  schema: "polars-telemetry/profile@1",
  plan: { physical: [{ id: 0, kind: "Filter", inputs: [] }], logical: [] },
  ...over,
});

const read = (raw: unknown): Profile => {
  const result = readProfile(raw);
  if ("problem" in result) throw new Error(result.problem);
  return result.profile;
};

describe("readProfile", () => {
  it("reads the exporter's own output", () => {
    const profile = read(fixture);
    expect(profile.plan.physical.length).toBeGreaterThan(0);
    expect(profile.polars_version).toBe("1.44.2");
  });

  it("refuses a schema version it does not know, saying why", () => {
    expect(readProfile(minimal({ schema: "polars-telemetry/profile@2" })))
      .toEqual({ problem: "schema polars-telemetry/profile@2 needs a newer viewer" });
  });

  it.each([
    ["a non-object", 42, "not an object"],
    ["another schema", { schema: "x/y@1" }, "not a polars-telemetry profile"],
    ["no plan", { schema: "polars-telemetry/profile@1" }, "no plan"],
    ["a node without inputs", minimal({ plan: { physical: [{ id: 0 }], logical: [] } }), "has no inputs"],
  ])("refuses %s", (_, raw, problem) => {
    const result = readProfile(raw);
    expect("problem" in result && result.problem).toContain(problem);
  });

  it("gives every node a role, even from a profile written before roles", () => {
    const node = read(minimal()).plan.physical[0]!;
    expect(node.role).toBe("selection");
  });

  it("fills what an older profile lacks instead of leaving it undefined", () => {
    const profile = read(minimal());
    expect(profile.call_site).toBeNull();
    expect(profile.failed).toBeNull();
    expect(profile.diagnostics).toEqual({});
    expect(profile.plan.physical[0]!.metrics).toBeNull();
  });
});

describe("readJsonl", () => {
  it("keeps the raw documents for storage alongside what it read", () => {
    const { profiles, raw } = readJsonl(JSON.stringify(minimal()));
    expect(profiles).toHaveLength(1);
    expect(raw).toEqual([minimal()]);
  });

  it("keeps a truncated tail from costing the whole file", () => {
    const { profiles, rejected } = readJsonl(`${JSON.stringify(minimal())}\n{"schema":"polars-tele`);
    expect(profiles).toHaveLength(1);
    expect(rejected).toEqual(["not valid JSON"]);
  });
});

describe("readSession", () => {
  it("drops a stored profile that no longer reads, and keeps the rest", () => {
    const session = readSession({
      id: "s", name: "s.jsonl", importedAt: 0, bytes: 0,
      profiles: [minimal(), { schema: "polars-telemetry/profile@1" }],
    });
    expect(session.profiles).toHaveLength(1);
  });
});

describe("toJsonl", () => {
  it("writes back every stored document, including one that no longer reads", () => {
    const stored = [fixture, minimal(), { schema: "polars-telemetry/profile@1" }];
    const session = readSession({ id: "s", name: "s.jsonl", importedAt: 0, bytes: 0, profiles: stored });
    const text = toJsonl(session.raw);
    expect(text.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual(stored);
    expect(readJsonl(text).profiles).toEqual(session.profiles.map((p) => ({ ...p, query_id: expect.any(String) })));
  });
});

describe("redacted", () => {
  it("reads what was masked, and null when nothing was", () => {
    const masked = readProfile(minimal({ redacted: ["strings", "paths"] }));
    const plain = readProfile(minimal());
    if (!("profile" in masked) || !("profile" in plain)) throw new Error("did not read");
    expect(masked.profile.redacted).toEqual(["strings", "paths"]);
    expect(plain.profile.redacted).toBeNull();
  });
});

describe("malformed numbers", () => {
  const read = (over: Record<string, unknown>) => {
    const result = readProfile(minimal(over));
    if (!("profile" in result)) throw new Error(result.problem);
    return result.profile;
  };

  it("keeps only finite numbers and booleans in metrics and diagnostics", () => {
    const profile = read({
      plan: {
        physical: [{ id: 0, kind: "Filter", inputs: [], metrics: { total_time_ns: "n/a", rows_sent: 5, done: true } }],
        logical: [],
      },
      diagnostics: { incomplete_nodes: {}, cpu_count: 8 },
    });
    expect(profile.plan.physical[0]!.metrics).toEqual({ rows_sent: 5, done: true });
    expect(profile.diagnostics).toEqual({ cpu_count: 8 });
  });

  it("drops a start time no date can hold, and an infinite row count", () => {
    const profile = read({ started_unix_ns: 1e22, result_rows: JSON.parse("1e400") });
    expect(profile.started_unix_ns).toBe(0);
    expect(profile.result_rows).toBeNull();
  });
});

describe("profiles without a query_id", () => {
  it("get the same id on every load, and an empty id counts as none", () => {
    const stored = { id: "s", name: "s.jsonl", importedAt: 0, bytes: 0, profiles: [minimal(), minimal({ query_id: "" })] };
    const first = readSession(stored).profiles.map((p) => p.query_id);
    const again = readSession(stored).profiles.map((p) => p.query_id);
    expect(first).toEqual(again);
    expect(first).toEqual(["profile-0", "profile-1"]);
  });

  it("are numbered the same when imported as when stored", () => {
    const text = [minimal(), minimal()].map((d) => JSON.stringify(d)).join("\n");
    const imported = readJsonl(text);
    const stored = readSession({ id: "s", name: "s.jsonl", importedAt: 0, bytes: 0, profiles: imported.raw });
    expect(imported.profiles.map((p) => p.query_id)).toEqual(stored.profiles.map((p) => p.query_id));
  });
});

describe("insights", () => {
  const finding = {
    rule: "exploding_join", kind: "problem", level: "warn", node_id: 7, node_kind: "EquiJoin",
    cpu_share: 0.4, blocked_share: 0.01, title: "Join emits 5x its larger input", fix: "join on the full key",
    evidence: [{ name: "growth", value: 5, unit: "ratio" }, { name: "note", value: "dropped", unit: "count" }],
  };
  const read = (insights: unknown) => {
    const result = readProfile({ ...JSON.parse(JSON.stringify(fixture)), insights });
    if ("problem" in result) throw new Error(result.problem);
    return result.profile.insights;
  };

  it("keeps findings as written, numbers only in their evidence", () => {
    expect(read({ schema: "insights@1", findings: [finding] })).toEqual([{ ...finding, evidence: [finding.evidence[0]] }]);
  });

  it("leaves out malformed findings and unknown schemas rather than guessing", () => {
    expect(read({ schema: "insights@1", findings: [finding, { ...finding, level: "fatal" }, "x"] })).toHaveLength(1);
    expect(read({ schema: "insights@2", findings: [finding] })).toBeNull();
    expect(read(undefined)).toBeNull();
  });
});
