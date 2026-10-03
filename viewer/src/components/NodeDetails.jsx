import { PROP_LABELS, GLOSSARY, icon } from "../lib/glossary";
import { ms, num } from "../lib/format";
import Help from "./Help";

export const COUNTERS = [
  ["Rows in", "rows_received", "rows"], ["Rows out", "rows_sent", "rows"],
  ["Morsels received", "morsels_received"], ["Morsels sent", "morsels_sent"],
  ["Largest morsel received", "largest_morsel_received", "rows"],
  ["Largest morsel sent", "largest_morsel_sent", "rows"],
  ["Total time", "total_time_ns", "ns"], ["Total poll time", "total_poll_time_ns", "ns"],
  ["Maximum poll time", "max_poll_time_ns", "ns"],
  ["Total number of polls", "total_polls"], ["Total polls stolen", "total_stolen_polls"],
  ["Total state update time", "total_state_update_time_ns", "ns"],
  ["Maximum state update time", "max_state_update_time_ns", "ns"],
  ["Number state updates", "total_state_updates"],
  ["IO active time", "io_total_active_ns", "ns"],
  ["IO bytes received", "io_total_bytes_received", "bytes"],
  ["IO bytes requested", "io_total_bytes_requested", "bytes"],
  ["IO bytes sent", "io_total_bytes_sent", "bytes"],
];

const looksExpr = (v) => typeof v === "string" && /[()"]/.test(v);

function Expr({ lines }) {
  return (
    <div className="expr">
      {lines.map((l, i) => (
        <div key={i}>
          {String(l).split(/(".*?")/).map((part, j) =>
            part.startsWith('"') ? <span className="s" key={j}>{part}</span> : <span key={j}>{part}</span>
          )}
        </div>
      ))}
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
  const anyIo = m && (m.io_total_active_ns || m.io_total_bytes_received || m.io_total_bytes_requested);

  return (
    <>
      <div className="card">
        <div className="hd">
          <span className="ic">{icon(node.kind)}</span>
          <span className="nm">{node.kind}</span>
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
          {COUNTERS.map(([label, key, unit]) => {
            if (m[key] == null) return null;
            if (key.startsWith("io_") && !anyIo) return null;
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
                <span className="v">{v}{unit && unit !== "ns" && unit !== "bytes"
                  ? <span className="u">{unit}</span> : null} {delta}</span>
              </div>
            );
          })}
        </div>
      ) : <div className="empty">Logical plan nodes carry structure only.</div>}
    </>
  );
}
