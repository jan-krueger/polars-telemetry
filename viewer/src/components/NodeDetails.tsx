import type { Finding, PlanNode } from "../model/profile";
import { PROP_LABELS, GLOSSARY } from "../lib/glossary";
import { visibleCounters } from "../lib/counters";
import { ROLES, conjunction, exprLines, roleOf } from "../lib/polars";
import { impact, measured, ruleDocs } from "../lib/insights";
import { useId } from "react";
import type { Replay } from "../model/profile";
import { bytes, customLabel, customValue, ms, nodeFacts, num } from "../lib/format";
import { history } from "../lib/replay";
import Help from "./Help";
import Tip, { TipText } from "./Tip";
import Code from "./Code";

const Ticks = ({ text }: { text: string }) =>
  text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

const looksExpr = (v: unknown): boolean => typeof v === "string" && /[()"]/.test(v);

function Expr({ lines }: { lines: unknown[] }) {
  return (
    <div className="expr code">
      {lines.map((expr, i) => (
        <div className="expr-item" key={i}>
          {exprLines(String(expr)).map((line, j) => <div key={j}><Code code={line} /></div>)}
        </div>
      ))}
    </div>
  );
}

const UNDESCRIBED = "error: prepare_visualization was not set during conversion";

function shown(name: string, raw: unknown): unknown {
  if (name === "predicate" && Array.isArray(raw) && raw.length) return conjunction(raw.map(String));
  if (name === "format_str" && raw === UNDESCRIBED) return "not recorded";
  if (name === "format_str" && typeof raw === "string" && raw.startsWith("SELECT [")) {
    return raw.slice("SELECT [".length, raw.lastIndexOf("]")).split("\n").map((line) => line.trim()).filter(Boolean);
  }
  return raw;
}

function Field({ name, value: raw }: { name: string; value: unknown }) {
  const value = shown(name, raw);
  const label = PROP_LABELS[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (typeof value === "boolean")
    return <div className="field inline"><span className="lbl">{label}</span>
      <span className="chip">{value ? "✓ true" : "× false"}</span></div>;
  if (typeof value === "number" || (typeof value === "string" && !looksExpr(value) && value.length < 40))
    return <div className="field inline"><span className="lbl">{label}</span>
      <span className="chip">{String(value)}</span></div>;

  let lines: string[];
  if (Array.isArray(value)) {
    lines = value.flat().map((v) =>
      v && typeof v === "object" && v.expr != null
        ? `${v.expr}${v.descending ? "  desc" : "  asc"}${v.nulls_last ? "  nulls last" : ""}`
        : typeof v === "object" ? JSON.stringify(v) : String(v));
  } else if (typeof value === "object") lines = [JSON.stringify(value, null, 1)];
  else lines = [String(value)];
  lines = lines.filter((l) => String(l).trim() !== "");
  if (!lines.length) return null;   // e.g. [[]] — present but carrying nothing

  return <div className="field"><div className="lbl">{label}</div><Expr lines={lines} /></div>;
}

interface Props {
  node: PlanNode | null;
  plan?: PlanNode[];
  findings?: Finding[];
  /** With a recording: the node as it ended, and the moment being replayed. */
  recorded?: { replay: Replay; final: PlanNode; end: number; t: number | null };
}

function MetricLine({ points, end, t, peak }: { points: [number, number][]; end: number; t: number | null; peak: boolean }) {
  const clip = useId();
  const top = Math.max(1e-9, ...points.map(([, v]) => v));
  const xy = points.map(([ms, v]): [number, number] => [(ms / end) * 100, 29 - (v / top) * 26]);
  const steps = peak ? xy.flatMap((p, i) => (i ? [[p[0], xy[i - 1]![1]] as [number, number], p] : [p])) : xy;
  const line = steps.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join("");
  const area = `${line}L100,30L0,30Z`;
  const x = t === null ? 100 : (t / end) * 100;
  return (
    <svg className="mline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <clipPath id={clip}><rect width={x} height={30} /></clipPath>
      <path className="mline-area mline--ahead" d={area} />
      <path className="mline-line mline--ahead" d={line} vectorEffect="non-scaling-stroke" />
      <g clipPath={`url(#${clip})`}>
        <path className="mline-area" d={area} />
        <path className="mline-line" d={line} vectorEffect="non-scaling-stroke" />
      </g>
      {t !== null && <line className="mline-at" x1={x} x2={x} y1={0} y2={30} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

export default function NodeDetails({ node, plan = [], findings, recorded }: Props) {
  if (!node) return <div className="empty">Select a node in a plan.</div>;
  const m = node.metrics;
  const props = Object.entries(node.properties || {})
    .filter(([k, v]) => v != null && k !== "type" && !(Array.isArray(v) && !v.length));
  const info = ROLES[roleOf(node)];

  return (
    <>
      <div className="card">
        <div className="hd">
          <Tip content={<TipText term={info.name} note={`Polars: ${node.kind}`} />}>
            <span className="nm-wrap" tabIndex={0}>
              {info.symbol ? <span className={`ra${info.muted ? " ra--muted" : ""}`}>{info.symbol}</span> : null}
              <span className="nm">{node.kind}</span>
            </span>
          </Tip>
          <span className="node-id">#{node.id}</span>
        </div>
        {findings?.length ? (
          <div className="reasons">
            {findings.map((f) => (
              <div className={`reason reason--${f.level}`} key={f.rule}>
                <b><Ticks text={f.title} /></b>
                {f.evidence.length ? (
                  <dl className="evidence">
                    {f.evidence.map((m) => (
                      <div key={m.name}><dt>{m.name}</dt><dd>{measured(m)}</dd></div>
                    ))}
                  </dl>
                ) : null}
                {f.fix ? <div className="fix">fix: <Ticks text={f.fix} /></div> : null}
                <span className="impact">
                  {f.kind === "problem" ? `${impact(f)} · ` : ""}
                  <a href={ruleDocs(f.rule)} target="_blank" rel="noreferrer">{f.rule}</a>
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {props.length
          ? props.map(([k, v]) => <Field key={k} name={k} value={v} />)
          : <div className="field"><span className="lbl">No properties on this node.</span></div>}
      </div>

      {m ? (
        <div className="card">
          <div className="hd">
            <span className="ic">☰</span><span className="nm">Node metrics</span>
            <Tip content={<TipText term={GLOSSARY.done![0]}>{GLOSSARY.done![1]}</TipText>}>
              <span className={m.done ? "badge badge--done" : "badge badge--open"} tabIndex={0}>
                {m.done ? "✓ Completed" : "⚠ Unfinished"}
              </span>
            </Tip>
          </div>
          {nodeFacts(node, plan).map((f) => (
            <div className="mrow mrow--fact" key={f.key}>
              <span className="k">{f.label}<Help term={f.key} /></span>
              <span className="v">{f.value}</span>
              <span className="fact-note">{f.note}</span>
            </div>
          ))}
          {node.custom?.map((c) => {
            const known = GLOSSARY[c.key];
            return (
              <div className="mrow" key={c.key}>
                {known ? (
                  <span className="k">{known[0]}<Help term={c.key} /></span>
                ) : (
                  <Tip content={<TipText term={customLabel(c.key)} note={`Polars: ${c.key}`} />}>
                    <span className="k" tabIndex={0}>{customLabel(c.key)}</span>
                  </Tip>
                )}
                <span className="v">{customValue(c)}</span>
              </div>
            );
          })}
          {visibleCounters(recorded?.final.metrics ?? m).map(({ label, key, unit, peak }) => {
            const raw = Number(m[key] ?? 0);
            const between = recorded && recorded.t !== null && !recorded.replay.times.includes(recorded.t);
            const v = unit === "ns" ? ms(raw / 1e6)
              : unit === "bytes" ? bytes(raw)
              : num(raw);
            return (
              <div className={recorded ? "mrow mrow--line" : "mrow"} key={key}>
                {recorded ? (
                  <MetricLine points={history(recorded.replay, recorded.final, recorded.end, key)}
                              end={recorded.end} t={recorded.t} peak={!!peak} />
                ) : null}
                <span className="k">{label}<Help term={key} /></span>
                <span className="v">
                  {between ? <span className="approx" title="Estimated between two samples">≈</span> : null}
                  {v}{unit === "rows"
                  ? <span className="u">rows</span> : null}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
