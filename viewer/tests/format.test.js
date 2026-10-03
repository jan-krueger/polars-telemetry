import { describe, expect, it } from "vitest";
import { diagnostics, shapeName } from "../src/lib/format.js";

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

  it("flags poor parallel efficiency", () => {
    const [chip] = diagnostics({ diagnostics: { parallel_efficiency: 0.2, cpu_count: 8 } });
    expect(chip.s).toBe("crit");
  });

  it("calls good parallel efficiency good", () => {
    const [chip] = diagnostics({ diagnostics: { parallel_efficiency: 0.9, cpu_count: 8 } });
    expect(chip.s).toBe("good");
  });
});
