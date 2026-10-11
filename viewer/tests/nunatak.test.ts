import { describe, expect, it } from "vitest";
import type { PlanNode } from "../src/model/profile";
import type { QueryOverview } from "../src/nunatak/api";
import { planDiff } from "../src/nunatak/plans";
import { byAttention, cadence, kinds, needsLook, reason, ruleName, times, when } from "../src/nunatak/words";

const NOW = new Date(2026, 9, 11, 9, 40).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime() * 1e6;

const query = (over: Partial<QueryOverview> = {}): QueryOverview => ({
  label: "orders/country_mix", service: "orders-etl", runs: 300, failed: 0, last_started_unix_ns: at(11, 9),
  total_wall_ms: 1000, usual_wall_ms: 310, usual_band_ms: [290, 330], recent_wall_ms: 1890, recent_runs: 24,
  recent_failed: 0, failed_before: 0, first_recent_failure_unix_ns: null, verdict: null, ratio: 1, rules: [],
  new_rules: [], new_rules_since_unix_ns: null, plan_changed_unix_ns: null, bins: [], days: [], ...over,
});

describe("Nunatak's words", () => {
  it("names rules plainly and ratios both ways", () => {
    expect(ruleName("python_udf")).toBe("Python function");
    expect(ruleName("some_new_rule")).toBe("some new rule");
    expect(times(6.1)).toBe("6.1× slower");
    expect(times(1 / 2.1)).toBe("2.1× faster");
    expect(times(14)).toBe("14× slower");
  });

  it("says how often a query runs", () => {
    expect(cadence(336, 14)).toBe("24 runs a day");
    expect(cadence(4, 14)).toBe("2 runs a week");
    expect(cadence(1, 14)).toBe("1 run");
  });

  it("says when, relative to today", () => {
    expect(when(at(11, 9, 5), NOW)).toMatch(/^today /);
    expect(when(at(10, 16), NOW)).toMatch(/^yesterday /);
    expect(when(at(8, 10), NOW)).not.toMatch(/today|yesterday/);
  });

  it("puts what needs a look first and leaves faster queries out of it", () => {
    const slower = query({ verdict: "slower", ratio: 6.1, label: "a", total_wall_ms: 1 });
    const failing = query({ recent_failed: 3, label: "b", total_wall_ms: 2 });
    const faster = query({ verdict: "faster", ratio: 0.5, label: "c", total_wall_ms: 3 });
    const calm = query({ label: "d", total_wall_ms: 4 });
    expect([calm, faster, failing, slower].sort(byAttention).map((q) => q.label)).toEqual(["b", "a", "c", "d"]);
    expect(kinds(query({ verdict: "slower", recent_failed: 1, new_rules: ["python_udf"] }))).toEqual(["slower", "failing", "warning"]);
    expect(needsLook(faster)).toBe(false);
    expect(needsLook(failing)).toBe(true);
  });

  it("explains a slowdown by the plan change when there was one", () => {
    const changed = query({ verdict: "slower", ratio: 6.1, plan_changed_unix_ns: at(9, 14, 2), new_rules: ["python_udf"] });
    expect(reason(changed, "slower", NOW)).toMatch(/^1\.9 s, usually 310 ms \(6\.1× slower\)\. Plan changed .+\. New: Python function\.$/);
    expect(reason(query({ verdict: "slower", ratio: 2 }), "slower", NOW)).toBe("1.9 s, usually 310 ms (2.0× slower). Same plan.");
    expect(reason(query({ recent_failed: 10, recent_runs: 24 }), "failing", NOW)).toBe("10 of 24 runs failed, none before.");
  });
});

describe("planDiff", () => {
  const node = (kind: string, label = ""): PlanNode => ({ id: 0, kind, label } as unknown as PlanNode);

  it("lists the nodes a plan added and dropped, counting repeats", () => {
    const before = [node("MultiScan", "orders"), node("Select", "adds revenue"), node("SimpleProjection"), node("SimpleProjection")];
    const now = [node("MultiScan", "orders"), node("Select", "adds revenue"), node("Select"), node("SimpleProjection")];
    expect(planDiff(now, before)).toEqual({ added: ["Select"], dropped: ["SimpleProjection"], same: 3 });
  });
});
