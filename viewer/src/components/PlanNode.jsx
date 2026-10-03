import { Handle, Position } from "@xyflow/react";
import { ROLES, relationName, roleOf } from "../lib/polars";
import { ms, num } from "../lib/format";
import Tip, { TipText } from "./Tip";

const bin = (p) => (p >= 50 ? 4 : p >= 10 ? 3 : p >= 1 ? 2 : 1);

/** The logical plan has no counters, so it is drawn as an outline: filling a
 *  node by CPU share would imply a cost it does not have. */
export default function PlanNode({ data, selected }) {
  const { node, share, logical, label } = data;
  const role = roleOf(node);
  const info = ROLES[role];
  // A relation is a leaf in the algebra: it is named, not given an operator.
  const relation = role === "scan" ? relationName(node.properties ?? {}) : "";
  const title = relation || node.kind;
  const b = bin(share);
  const style = logical
    ? {}
    : { background: `var(--sq${b})`, color: `var(--sq${b}-ink)`, borderColor: "transparent" };

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
          {share >= 0.1 ? `${num(share, 1)}% · ` : ""}{ms((node.metrics.total_time_ns ?? 0) / 1e6)}
        </div>
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
