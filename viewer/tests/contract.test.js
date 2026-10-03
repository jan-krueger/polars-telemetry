import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COUNTERS } from "../src/lib/counters";
import { GLOSSARY } from "../src/lib/glossary.js";
import { diagnostics } from "../src/lib/format.js";

const profile = JSON.parse(
  readFileSync(new URL("./fixtures/profile.json", import.meta.url), "utf8"),
);

// Written by the Python side but deliberately not surfaced. Anything else new
// must be shown or added here on purpose, never by omission.
const NOT_SHOWN = new Set(["node_id", "done"]);

// Computed by the Python side but with nothing to render yet.
const NO_CHIP = new Set(["cpu_count", "filter_rows_dropped", "incomplete_nodes"]);

describe("the profile contract", () => {
  it("shows every counter the exporter writes", () => {
    const node = profile.plan.physical.find((n) => n.metrics);
    const shown = new Set(COUNTERS.map((c) => c.key));
    const unshown = Object.keys(node.metrics).filter(
      (k) => !shown.has(k) && !NOT_SHOWN.has(k),
    );
    expect(unshown).toEqual([]);
  });

  it("explains every counter it shows", () => {
    expect(COUNTERS.filter((c) => !GLOSSARY[c.key]).map((c) => c.label)).toEqual([]);
  });

  it("renders a chip for every diagnostic the exporter computes", () => {
    const rendered = new Set(diagnostics(profile).map((chip) => chip.k));
    const missing = Object.keys(profile.diagnostics).filter(
      (k) => !rendered.has(k) && !NO_CHIP.has(k),
    );
    expect(missing).toEqual([]);
  });

  it("explains every diagnostic it renders", () => {
    const missing = diagnostics(profile).map((c) => c.k).filter((k) => !GLOSSARY[k]);
    expect(missing).toEqual([]);
  });
});
