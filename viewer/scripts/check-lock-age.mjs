import { readFileSync } from "node:fs";

const MIN_AGE_DAYS = 7;
const CONCURRENCY = 16;
const ATTEMPTS = 4;

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const locked = new Map();
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || !entry.version || entry.link) continue;
  const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  locked.set(`${name}@${entry.version}`, { name, version: entry.version });
}

const cutoff = Date.now() - MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
const published = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500) throw Object.assign(new Error(`${url}: HTTP ${r.status}`), { final: true });
      throw new Error(`${url}: HTTP ${r.status}`);
    } catch (e) {
      if (e.final || attempt === ATTEMPTS) throw e;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

async function publishTimes(name) {
  if (!published.has(name)) {
    const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}`;
    published.set(name, fetchJson(url).then((doc) => doc.time ?? {}));
  }
  return published.get(name);
}

const queue = [...locked.values()];
const tooNew = [];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const time = (await publishTimes(next.name))[next.version];
    if (!time) throw new Error(`${next.name}@${next.version}: no publish time in the registry`);
    if (Date.parse(time) > cutoff) tooNew.push(`${next.name}@${next.version} (published ${time})`);
  }
}));

if (tooNew.length) {
  console.error(`check-lock-age: ${tooNew.length} locked packages are younger than ${MIN_AGE_DAYS} days:`);
  for (const line of tooNew.sort()) console.error(`  ${line}`);
  console.error("Re-lock with `uv run nox -s viewer-lock`.");
  process.exit(1);
}
console.log(`check-lock-age: ${locked.size} locked packages, none younger than ${MIN_AGE_DAYS} days`);
