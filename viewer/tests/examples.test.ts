import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readJsonl } from "../src/model/read";

const example = (name: string) => readJsonl(readFileSync(new URL(`../../docs/schemas/examples/${name}`, import.meta.url), "utf8"));

describe("the protocol's example recordings", () => {
  it("open as a finished query with every sample", () => {
    const { profiles, rejected } = example("finished.jsonl");
    expect(rejected).toEqual([]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.unfinished).toBe(false);
    expect(profiles[0]!.replay!.times.length).toBeGreaterThanOrEqual(7);
  });

  it("open a query the recording ended before, with the counters of its last sample", () => {
    const [profile] = example("unfinished.jsonl").profiles;
    expect(profile!.unfinished).toBe(true);
    expect(profile!.cpu_ms).toBeGreaterThan(0);
  });
});
