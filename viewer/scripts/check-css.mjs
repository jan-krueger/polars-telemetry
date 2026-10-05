/**
 * A bare single-class selector (`.right`) applies to every element carrying
 * that class anywhere. When two components use the same generic name, one
 * silently inherits the other's rules -- a `.right` meant for a header group
 * once turned an aside into a centred flex row, visible only in a screenshot.
 *
 * Fails when a bare selector's class is used from more than one component,
 * unless it is listed as shared on purpose.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// `ra` is the relational-algebra notation, styled the same wherever it appears.
const SHARED_ON_PURPOSE = new Set(["delta-up", "delta-down", "btn", "link", "small", "mono", "ra", "ra--muted", "x", "picker", "search"]);

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const sources = walk("src").filter((p) => p.endsWith(".jsx"));

const usedBy = new Map();
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  for (const [, quoted, template] of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    for (const name of (quoted ?? template ?? "").split(/[\s${}?:"'`+]+/)) {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;
      (usedBy.get(name) ?? usedBy.set(name, new Set()).get(name)).add(file);
    }
  }
}

const css = readFileSync("src/styles.css", "utf8");
const bare = new Set(
  [...css.matchAll(/(^|[,}])\s*\.([a-z][a-z0-9-]*)\s*\{/gm)].map((m) => m[2]),
);

const clashes = [...bare]
  .filter((name) => !SHARED_ON_PURPOSE.has(name) && (usedBy.get(name)?.size ?? 0) > 1)
  .map((name) => `  .${name} — used by ${[...usedBy.get(name)].join(", ")}`);

if (clashes.length) {
  console.error("Bare selectors shared across components:\n" + clashes.join("\n"));
  console.error("\nScope them (.pnode--sel) or add to SHARED_ON_PURPOSE if deliberate.");
  process.exit(1);
}
console.log(`check-css: ${bare.size} bare selectors, no cross-component clashes`);
