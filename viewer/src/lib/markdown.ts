import type { PlanNode, Profile } from "../model/profile";
import { busy, compact, inputs, num, span } from "./format";
import { cpuMs } from "./graph";
import { impact, measured, ruleDocs } from "./insights";
import { basename, relationName } from "./polars";
import { iso } from "./time";
import { title } from "../state/viewer";

const LABEL_MAX = 60;

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function rowsOut(node: PlanNode): number | undefined {
  const m = node.metrics;
  if (!m) return undefined;
  const rows = node.role === "sink" ? m.rows_received : m.rows_sent;
  return typeof rows === "number" ? rows : undefined;
}

function summary(profile: Profile): string[] {
  const cells: [string, string][] = [["Wall time", span(profile.wall_ms)]];
  if (profile.cpu_ms > 0) cells.push(["Node CPU", span(profile.cpu_ms)]);
  const b = busy(profile);
  if (b) cells.push(["Threads busy", `${num(b.threads, 1)}${b.of ? ` of ${b.of}` : ""}`]);
  const io = profile.query_metrics?.io_total_active_ns;
  if (io != null) cells.push(["IO in flight", span(io / 1e6)]);
  if (profile.result_rows != null) cells.push(["Rows out", compact(profile.result_rows)]);
  return [
    `| ${cells.map(([name]) => name).join(" | ")} |`,
    `|${cells.map(() => " ---: ").join("|")}|`,
    `| ${cells.map(([, value]) => cell(value)).join(" | ")} |`,
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

/** Sinks first, inputs below, as Polars prints plans; a node shared by several consumers is expanded once. */
export function planTree(plan: PlanNode[]): string {
  const byId = new Map(plan.map((n) => [n.id, n]));
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
      facts.push(span(ms));
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
export function queryMarkdown(profile: Profile): string {
  const where = profile.call_site
    ? ` · \`${basename(profile.call_site.filepath)}:${profile.call_site.lineno}\` in \`${profile.call_site.function}()\``
    : "";
  const reads = inputs(profile);
  const lines = [
    `### ${title(profile)}`,
    "",
    `${reads.length ? `Reads ${reads.join(", ")} · ` : ""}\`${profile.fingerprint}\` · ${iso(profile.started_unix_ns).slice(0, 16).replace("T", " ")} UTC · Polars ${profile.polars_version}${where}`,
    "",
  ];
  if (profile.failed) lines.push(`**Failed:** ${profile.failed}`, "");
  if (profile.redacted?.length) lines.push(`Masked before export: ${profile.redacted.join(", ").replace("_", " ")}.`, "");
  lines.push(...summary(profile), "", ...findings(profile));
  lines.push(
    "<details><summary>Physical plan</summary>",
    "",
    "```text",
    planTree(profile.plan.physical),
    "```",
    "",
    "</details>",
    "",
    `<sub>From the [polars-telemetry viewer](https://jan-krueger.github.io/polars-telemetry/viewer/).</sub>`,
  );
  return lines.join("\n");
}
