import type { PlanNode, Profile } from "../model/profile";
import { busy, compact, num, span, tableName } from "./format";
import { cpuMs } from "./graph";
import { impact, measured, ruleDocs } from "./insights";
import { basename, relationName } from "./polars";
import { iso } from "./time";
import { title } from "../state/viewer";

const LABEL_MAX = 60;
const NOTED_SHARE = 0.01;

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function change(now: number | null | undefined, before: number | null | undefined): string {
  if (now == null || before == null) return "";
  const pct = before ? ((now - before) / before) * 100 : 0;
  if (Math.abs(pct) < 0.5) return " (=)";
  return ` (${pct > 0 ? "+" : ""}${num(pct, 0)}%)`;
}

function rowsOut(node: PlanNode): number | undefined {
  const m = node.metrics;
  if (!m) return undefined;
  const rows = node.role === "sink" ? m.rows_received : m.rows_sent;
  return typeof rows === "number" ? rows : undefined;
}

function summary(profile: Profile, compare: Profile | null): string[] {
  const threads = (p: Profile): string => {
    const b = busy(p);
    return b ? `${num(b.threads, 1)}${b.of ? ` of ${b.of}` : ""}` : "—";
  };
  const rows: [string, string, string | null][] = [
    ["Wall time", span(profile.wall_ms) + change(profile.wall_ms, compare?.wall_ms), compare && span(compare.wall_ms)],
  ];
  if (profile.cpu_ms > 0) {
    rows.push(["Node CPU", span(profile.cpu_ms) + change(profile.cpu_ms, compare?.cpu_ms), compare && span(compare.cpu_ms)]);
  }
  if (busy(profile)) rows.push(["Threads busy", threads(profile), compare && threads(compare)]);
  if (profile.result_rows != null) {
    rows.push(["Rows out", compact(profile.result_rows) + change(profile.result_rows, compare?.result_rows),
               compare && (compare.result_rows == null ? "—" : compact(compare.result_rows))]);
  }
  const head = compare ? ["", "This run", "Compared run"] : ["", "This run"];
  return [
    `| ${head.join(" | ")} |`,
    `|${head.map((_, i) => (i ? " ---: " : " --- ")).join("|")}|`,
    ...rows.map(([name, now, before]) => `| ${[name, now, ...(compare ? [before ?? "—"] : [])].map(cell).join(" | ")} |`),
  ];
}

function findings(profile: Profile): string[] {
  const problems = (profile.insights ?? []).filter((f) => f.kind === "problem");
  if (!problems.length) return [];
  return [
    "**Findings**",
    "",
    ...problems.map((f) => {
      const evidence = f.evidence.map((m) => `${m.name} ${measured(m)}`).join(", ");
      return `- **${f.level === "warn" ? "Warning" : "Info"}:** ${f.title} (${impact(f)}${evidence ? `; ${evidence}` : ""})`
        + `${f.fix ? `. Fix: ${f.fix}` : ""} [${f.rule}](${ruleDocs(f.rule)})`;
    }),
    "",
  ];
}

/** Sinks first, inputs below, as polars prints plans; a node shared by several consumers is expanded once. */
export function planTree(plan: PlanNode[], compare: PlanNode[] | null = null): string {
  const byId = new Map(plan.map((n) => [n.id, n]));
  const before = new Map((compare ?? []).map((n) => [n.id, n]));
  const consumed = new Set(plan.flatMap((n) => n.inputs));
  const roots = plan.filter((n) => !consumed.has(n.id));
  const total = plan.reduce((sum, n) => sum + cpuMs(n), 0);
  const shown = new Set<number>();
  const lines: { left: string; right: string }[] = [];

  const visit = (node: PlanNode, lead: string, branch: string) => {
    const relation = node.role === "scan" ? relationName(node.properties) : "";
    const name = [node.kind, relation, node.label && clip(node.label, LABEL_MAX)].filter(Boolean).join(" ");
    if (shown.has(node.id)) {
      lines.push({ left: `${lead}${branch}${node.kind} (shared, see above)`, right: "" });
      return;
    }
    shown.add(node.id);
    const facts: string[] = [];
    if (node.metrics) {
      const ms = cpuMs(node);
      const old = before.get(node.id);
      const noted = total > 0 && ms / total >= NOTED_SHARE;
      facts.push(`${span(ms)}${noted && old?.metrics ? change(ms, cpuMs(old)) : ""}`);
      if (total > 0 && ms / total >= 0.001) facts.push(`${num((ms / total) * 100, 1)}%`);
      const rows = rowsOut(node);
      if (rows !== undefined) facts.push(`${compact(rows)} rows`);
    }
    lines.push({ left: `${lead}${branch}${name}`, right: facts.join(" · ") });
    const inputs = node.inputs.map((id) => byId.get(id)).filter((n): n is PlanNode => !!n);
    const below = lead + (branch === "├─ " ? "│  " : branch === "└─ " ? "   " : "");
    inputs.forEach((input, i) => visit(input, below, i === inputs.length - 1 ? "└─ " : "├─ "));
  };
  roots.forEach((root) => visit(root, "", ""));

  const width = Math.max(0, ...lines.filter((l) => l.right).map((l) => l.left.length));
  return lines.map(({ left, right }) => (right ? `${left.padEnd(width)}  ${right}` : left)).join("\n");
}

/** A query as Markdown for an issue or pull request: what it cost, what was found, and its physical plan. */
export function queryMarkdown(profile: Profile, compare: Profile | null = null): string {
  const where = profile.call_site
    ? ` · \`${basename(profile.call_site.filepath)}:${profile.call_site.lineno}\` in \`${profile.call_site.function}()\``
    : "";
  const table = profile.label ? tableName(profile) : null;
  const lines = [
    `### ${title(profile)}`,
    "",
    `${table ? `${table} · ` : ""}\`${profile.fingerprint}\` · ${iso(profile.started_unix_ns).slice(0, 16).replace("T", " ")} UTC · polars ${profile.polars_version}${where}`,
    "",
  ];
  if (profile.failed) lines.push(`**Failed:** ${profile.failed}`, "");
  if (profile.redacted?.length) lines.push(`Masked before export: ${profile.redacted.join(", ").replace("_", " ")}.`, "");
  lines.push(...summary(profile, compare), "", ...findings(profile));
  lines.push(
    "<details><summary>Physical plan</summary>",
    "",
    "```text",
    planTree(profile.plan.physical, compare?.plan.physical ?? null),
    "```",
    "",
    "</details>",
    "",
    `<sub>From the [polars-telemetry viewer](https://jan-krueger.github.io/polars-telemetry/viewer/).</sub>`,
  );
  return lines.join("\n");
}
