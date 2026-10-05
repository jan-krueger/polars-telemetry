import { describe, expect, it } from "vitest";
import { ageGroup, clock, instant, ranBetween, ranOf, shortWhen, spansDays } from "../src/lib/time";
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
    const starts = [at("2026-10-03T11:42:00Z"), unrecorded, at("2026-10-03T11:30:00Z")].map((p) => p.started_unix_ns);
    const span = ranBetween(ranOf(starts), "UTC");
    expect(span).toMatch(/11:30/);
    expect(span).toMatch(/11:42/);
    expect(ranOf([unrecorded.started_unix_ns])).toBeNull();
  });
});

describe("session list times", () => {
  const now = new Date(2026, 9, 5, 14, 0).getTime();
  const at = (day: number, hour = 9) => new Date(2026, 9, day, hour, 30).getTime();

  it("groups by local day: today, yesterday, this week, older", () => {
    expect([at(5), at(4, 23), at(1), at(28 - 30)].map((ms) => ageGroup(ms, now)))
      .toEqual(["Today", "Yesterday", "This week", "Older"]);
  });

  it("shows the time for today and the date otherwise", () => {
    expect(shortWhen(at(5), now)).toMatch(/9:30|09:30/);
    expect(shortWhen(at(1), now)).toMatch(/2026/);
  });
});
