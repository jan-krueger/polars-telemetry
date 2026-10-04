import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { badge, byNode, impact, warned } from "../src/lib/insights";
import { layout, planGraph, toFlow, withSelection } from "../src/lib/graph";
import { readProfile } from "../src/model/read";
import type { Finding, Profile } from "../src/model/profile";

const read = readProfile(JSON.parse(readFileSync(new URL("./fixtures/profile.json", import.meta.url), "utf8")));
if ("problem" in read) throw new Error(read.problem);
const base = read.profile;
const [first, second] = base.plan.physical;

const finding = (node_id: number, level: Finding["level"], cpu = 0.2, blocked = 0): Finding => ({
  rule: `rule_${level}`, kind: level === "applied" ? "applied" : "problem", level, node_id, node_kind: "X",
  cpu_share: cpu, blocked_share: blocked, title: "t", detail: "d", evidence: {},
});
const profile = (insights: Finding[] | null): Profile => ({ ...base, insights });

describe("findings in the viewer", () => {
  it("badges a node by its most serious finding, never for an applied fact", () => {
    const found = byNode(profile([finding(first!.id, "info"), finding(first!.id, "warn"), finding(second!.id, "applied")]));
    expect(badge(found.get(first!.id))).toBe("warn");
    expect(badge(found.get(second!.id))).toBeNull();
  });

  it("lists warned nodes once each, in the order the findings rank them", () => {
    const p = profile([finding(second!.id, "warn"), finding(first!.id, "warn"), finding(second!.id, "warn"), finding(first!.id, "info")]);
    expect(warned(p)).toEqual([second!.id, first!.id]);
    expect(warned(profile(null))).toEqual([]);
  });

  it("names the basis of a finding's impact", () => {
    expect(impact(finding(1, "warn", 0.461, 0.015))).toBe("46% of CPU");
    expect(impact(finding(1, "warn", 0.101, 0.585))).toBe("59% of wall time");
    expect(impact(finding(1, "info", 0.004, 0))).toBe("0.4% of CPU");
  });

  it("keeps a flagged node's class through fading and selection", () => {
    const plan = base.plan.physical;
    const findings = byNode(profile([finding(first!.id, "warn")]));
    const flow = toFlow(plan, layout(planGraph(plan)), { logical: false, selectedId: null, thresholdMs: 1e9, findings });
    const flagged = flow.nodes.find((n) => n.id === String(first!.id))!;
    expect(flagged.className).toBe("faded flag-warn");
    expect(flagged.data.finding).toBe("warn");
    const picked = withSelection(flow, first!.id).nodes.find((n) => n.id === String(first!.id))!;
    expect(picked.className).toBe("flag-warn");
  });
});
