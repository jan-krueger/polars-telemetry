import { describe, expect, it } from "vitest";
import { clock, instant, ranBetween, spansDays } from "../src/lib/time";
import type { Profile } from "../src/model/profile";

const at = (iso: string) => ({ started_unix_ns: Date.parse(iso) * 1e6 }) as Profile;
const unrecorded = { started_unix_ns: 0 } as Profile;

describe("time", () => {
  it("counts days in the reader's zone, not UTC", () => {
    // 23:30 and 00:30 UTC: two days in UTC, one evening in New York.
    const evening = [at("2026-10-02T23:30:00Z"), at("2026-10-03T00:30:00Z")];
    expect(spansDays(evening, "UTC")).toBe(true);
    expect(spansDays(evening, "America/New_York")).toBe(false);
    expect(spansDays([at("2026-10-03T09:00:00Z"), unrecorded], "UTC")).toBe(false);
  });

  it("adds the date only when asked", () => {
    const ns = at("2026-10-03T09:30:03Z").started_unix_ns;
    expect(clock(ns, false, "UTC")).not.toContain("2026");
    expect(clock(ns, true, "UTC")).toContain("2026");
    expect(clock(ns, false, "UTC")).not.toBe(clock(ns, false, "Asia/Tokyo"));
  });

  it("states the exact instant in UTC and the zone shown", () => {
    const ns = at("2026-10-03T09:30:03.250Z").started_unix_ns;
    expect(instant(ns, "Europe/Berlin")).toBe("2026-10-03T09:30:03.250Z · shown in Europe/Berlin");
  });

  it("spans a session's queries, first to last, in any order", () => {
    const span = ranBetween([at("2026-10-03T11:42:00Z"), unrecorded, at("2026-10-03T11:30:00Z")], "UTC");
    expect(span).toMatch(/11:30/);
    expect(span).toMatch(/11:42/);
    expect(ranBetween([unrecorded], "UTC")).toBeNull();
  });
});
