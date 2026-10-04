import { PROP_LABELS, GLOSSARY } from "../lib/glossary";
import { visibleCounters } from "../lib/counters";
import { ROLES, conjunction, exprLines, roleOf } from "../lib/polars";
import { impact, measured, ruleDocs } from "../lib/insights";
import { bytes, ms, num } from "../lib/format";
import Help from "./Help";
import Tip, { TipText } from "./Tip";
import Code from "./Code";

const Ticks = ({ text }) =>
  text.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

const looksExpr = (v) => typeof v === "string" && /[()"]/.test(v);

function Expr({ lines }) {
  // One block per expression, one line per method call; a line still too wide
  // scrolls with its block rather than wrapping mid-token.
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

/** A property as it reads best: one predicate, or the expressions an in-memory fallback runs. */
function shown(name, raw) {
  if (name === "predicate" && Array.isArray(raw) && raw.length) return conjunction(raw.map(String));
  if (name === "format_str" && raw === UNDESCRIBED) return "not recorded";
  if (name === "format_str" && typeof raw === "string" && raw.startsWith("SELECT [")) {
    return raw.slice("SELECT [".length, raw.lastIndexOf("]")).split("\n").map((line) => line.trim()).filter(Boolean);
  }
  return raw;
}

function Field({ name, value: raw }) {
  const value = shown(name, raw);
  const label = PROP_LABELS[name] ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  if (typeof value === "boolean")
    return <div className="field inline"><span className="lbl">{label}</span>
      <span className="chip">{value ? "✓ true" : "× false"}</span></div>;
  if (typeof value === "number" || (typeof value === "string" && !looksExpr(value) && value.length < 40))
    return <div className="field inline"><span className="lbl">{label}</span>
      <span className="chip">{String(value)}</span></div>;

  let lines;
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

export default function NodeDetails({ node, compareNode, findings }) {
  if (!node) return <div className="empty">Select a node in a plan.</div>;
  const m = node.metrics, other = compareNode?.metrics;
  const props = Object.entries(node.properties || {})
    .filter(([k, v]) => v != null && k !== "type" && !(Array.isArray(v) && !v.length));
  const info = ROLES[roleOf(node)];

  return (
    <>
      <div className="card">
        <div className="hd">
          <Tip content={<TipText term={info.name} note={`polars: ${node.kind}`} />}>
            <span className="nm-wrap" tabIndex={0}>
              {info.symbol ? <span className={`ra${info.muted ? " ra--muted" : ""}`}>{info.symbol}</span> : null}
              <span className="nm">{node.kind}</span>
            </span>
          </Tip>
          <span style={{ marginLeft: "auto", font: "10.5px ui-monospace,monospace", color: "var(--muted)" }}>
            #{node.id}
          </span>
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
            <Tip content={<TipText term={GLOSSARY.done[0]}>{GLOSSARY.done[1]}</TipText>}>
              <span className="badge" tabIndex={0}
                    style={{ marginLeft: "auto", color: m.done ? "var(--good)" : "var(--warn)" }}>
                {m.done ? "✓ Completed" : "⚠ Unfinished"}
              </span>
            </Tip>
          </div>
          {visibleCounters(m).map(({ label, key, unit }) => {
            const raw = m[key];
            const v = unit === "ns" ? ms(raw / 1e6)
              : unit === "bytes" ? bytes(raw)
              : num(raw);
            let delta = null;
            if (other && other[key] != null && other[key] !== raw) {
              const pct = other[key] ? ((raw - other[key]) / other[key]) * 100 : 0;
              delta = <span className={pct > 0 ? "delta-up" : "delta-down"}
                            style={{ fontWeight: 400, fontSize: 10.5 }}>
                {pct > 0 ? "+" : ""}{num(pct, 0)}%</span>;
            }
            return (
              <div className="mrow" key={key}>
                <span className="k">{label}<Help term={key} /></span>
                <span className="v">{v}{unit === "rows"
                  ? <span className="u">rows</span> : null} {delta}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
