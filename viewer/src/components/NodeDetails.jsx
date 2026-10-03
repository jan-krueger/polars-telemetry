import { PROP_LABELS, GLOSSARY } from "../lib/glossary";
import { visibleCounters } from "../lib/counters";
import { ROLES, roleOf } from "../lib/polars";
import { ms, num } from "../lib/format";
import Help from "./Help";
import Code from "./Code";

const looksExpr = (v) => typeof v === "string" && /[()"]/.test(v);

function Expr({ lines }) {
  return (
    <div className="expr code">
      {lines.map((l, i) => <div key={i}><Code code={String(l)} /></div>)}
    </div>
  );
}

function Field({ name, value }) {
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

export default function NodeDetails({ node, compareNode }) {
  if (!node) return <div className="empty">Select a node in a plan.</div>;
  const m = node.metrics, other = compareNode?.metrics;
  const props = Object.entries(node.properties || {})
    .filter(([k, v]) => v != null && k !== "type" && !(Array.isArray(v) && !v.length));
  const info = ROLES[roleOf(node)];

  return (
    <>
      <div className="card">
        <div className="hd">
          {info.symbol
            ? <span className={`ra${info.muted ? " ra--muted" : ""}`} title={info.name}>{info.symbol}</span>
            : null}
          <span className="nm" title={info.name}>{node.kind}</span>
          <span style={{ marginLeft: "auto", font: "10.5px ui-monospace,monospace", color: "var(--muted)" }}>
            #{node.id}
          </span>
        </div>
        {props.length
          ? props.map(([k, v]) => <Field key={k} name={k} value={v} />)
          : <div className="field"><span className="lbl">No properties on this node.</span></div>}
      </div>

      {m ? (
        <div className="card">
          <div className="hd">
            <span className="ic">☰</span><span className="nm">Node metrics</span>
            <span className="badge" title={GLOSSARY.done[1]}
                  style={{ marginLeft: "auto", color: m.done ? "var(--good)" : "var(--warn)" }}>
              {m.done ? "✓ Completed" : "⚠ Unfinished"}
            </span>
          </div>
          {visibleCounters(m).map(({ label, key, unit }) => {
            const raw = m[key];
            const v = unit === "ns" ? ms(raw / 1e6)
              : unit === "bytes" ? (raw >= 1048576 ? num(raw / 1048576, 1) + " MiB" : num(raw / 1024, 1) + " KiB")
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
