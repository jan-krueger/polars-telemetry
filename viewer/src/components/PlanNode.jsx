import { Handle, Position } from "@xyflow/react";
import { ROLES, relationName, roleOf } from "../lib/polars";
import { num, span } from "../lib/format";
import { cpuMs } from "../lib/graph";
import Tip, { TipText } from "./Tip";

const bin = (p) => (p >= 50 ? 4 : p >= 10 ? 3 : p >= 1 ? 2 : 1);

/** The logical plan has no counters, so it is drawn as an outline: filling a
 *  node by CPU share would imply a cost it does not have. */
export default function PlanNode({ data, selected }) {
  const { node, share, logical, label, far, finding } = data;
  const role = roleOf(node);
  const info = ROLES[role];
  // A relation is a leaf in the algebra: it is named, not given an operator.
  const relation = role === "scan" ? relationName(node.properties ?? {}) : "";
  const title = relation || node.kind;
  const b = bin(share);
  const style = logical
    ? {}
    : { background: `var(--sq${b})`, color: `var(--sq${b}-ink)`, borderColor: "transparent" };

  if (far) {
    return (
      <div className={`pnode${logical ? " logical" : ""}${selected ? " pnode--sel" : ""}`} style={style}>
        <Handle type="target" position={Position.Bottom} />
        <Handle type="source" position={Position.Top} />
      </div>
    );
  }

  return (
    <div className={`pnode${logical ? " logical" : ""}${selected ? " pnode--sel" : ""}`}
         style={{ ...style, position: "relative" }}>
      <Handle type="target" position={Position.Bottom} />
      <Tip content={<TipText term={info.name} note={`polars: ${node.kind}`} />}>
        <div className="t1">
          {info.symbol ? <span className={`ra${info.muted ? " ra--muted" : ""}`}>{info.symbol}</span> : null}
          {title}
        </div>
      </Tip>
      {label ? <div className="t2">{label}</div> : null}
      {node.metrics ? (
        <div className="t3">
          {share >= 0.1 ? `${num(share, 1)}% · ` : ""}{span(cpuMs(node))}
        </div>
      ) : null}
      {finding ? (
        <span className={`pflag pflag--${finding}`} aria-label={finding === "warn" ? "Warning" : "Information"}>
          {finding === "warn"
            ? <svg viewBox="0 0 12 11" width="12" height="11" aria-hidden="true"><path d="M6 .8 11.4 10.2H.6Z" fill="currentColor" /><path d="M6 4v3M6 8.4v.2" stroke="var(--surface)" strokeWidth="1.4" strokeLinecap="round" /></svg>
            : <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>}
        </span>
      ) : null}
      {!logical && node.metrics ? (
        <Tip content={node.metrics.done ? "Completed" : "Unfinished when the counters were read"}>
          <span className="status"
                style={{ background: node.metrics.done ? "var(--good)" : "var(--warn)" }} />
        </Tip>
      ) : null}
      <Handle type="source" position={Position.Top} />
    </div>
  );
}
