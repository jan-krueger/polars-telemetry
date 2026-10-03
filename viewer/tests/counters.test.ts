import { describe, expect, it } from "vitest";
import { COUNTERS, visibleCounters } from "../src/lib/counters";

const zero = Object.fromEntries(COUNTERS.map((c) => [c.key, 0]));

describe("visibleCounters", () => {
  it("hides the IO group for in-memory work", () => {
    expect(visibleCounters(zero).some((c) => c.group === "io")).toBe(false);
  });

  it("shows the whole IO group for a sink that only writes", () => {
    const keys = visibleCounters({ ...zero, io_total_bytes_sent: 4096 }).map((c) => c.key);
    expect(keys).toContain("io_total_bytes_sent");
    expect(keys).toContain("io_total_active_ns");
  });

  it("skips a counter the profile does not carry", () => {
    const { rows_sent: _dropped, ...rest } = zero;
    expect(visibleCounters(rest).map((c) => c.key)).not.toContain("rows_sent");
  });
});
