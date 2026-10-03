import { describe, expect, it } from "vitest";
import { diagnostics, parseJsonl, profileProblem, shapeName } from "../src/lib/format.js";

const profile = (over = {}) => ({
  schema: "polars-telemetry/profile@1",
  plan: { physical: [{ id: 0, inputs: [] }], logical: [{ id: 0, inputs: [] }] },
  ...over,
});

describe("profileProblem", () => {
  it("accepts a well-formed profile", () => {
    expect(profileProblem(profile())).toBeNull();
  });

  it.each([
    ["not an object", 42],
    ["not a polars-telemetry profile", { schema: "something/else@1", plan: {} }],
    ["no plan", { schema: "polars-telemetry/profile@1" }],
  ])("rejects %s", (reason, value) => {
    expect(profileProblem(value)).toContain(reason.split(" ")[0]);
  });

  it("rejects a schema it does not know, by version", () => {
    expect(profileProblem(profile({ schema: "polars-telemetry/profile@2" })))
      .toMatch(/needs a newer viewer/);
  });

  it("rejects a node the layout would throw on", () => {
    expect(profileProblem(profile({ plan: { physical: [{ id: 0 }], logical: [] } })))
      .toMatch(/inputs/);
  });
});

describe("parseJsonl", () => {
  it("keeps a truncated tail from costing the whole file", () => {
    const text = JSON.stringify(profile()) + "\n" + '{"schema":"polars-tele';
    expect(parseJsonl(text)).toHaveLength(1);
  });

  it("skips blank lines", () => {
    expect(parseJsonl(`\n\n${JSON.stringify(profile())}\n\n`)).toHaveLength(1);
  });

  it("reports why a line was rejected", () => {
    const parsed = parseJsonl('{"schema":"polars-telemetry/profile@1"}');
    expect(parsed).toHaveLength(0);
    expect(parsed.rejected).toEqual(["no plan"]);
  });
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

  it("flags poor parallel efficiency", () => {
    const [chip] = diagnostics({ diagnostics: { parallel_efficiency: 0.2, cpu_count: 8 } });
    expect(chip.s).toBe("crit");
  });

  it("calls good parallel efficiency good", () => {
    const [chip] = diagnostics({ diagnostics: { parallel_efficiency: 0.9, cpu_count: 8 } });
    expect(chip.s).toBe("good");
  });
});
