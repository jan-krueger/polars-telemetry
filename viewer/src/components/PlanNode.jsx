import { Handle, Position } from "@xyflow/react";
import { icon } from "../lib/glossary";
import { ms, num } from "../lib/format";

const bin = (p) => (p >= 50 ? 4 : p >= 10 ? 3 : p >= 1 ? 2 : 1);

/** The logical plan has no counters, so it is drawn as an outline: filling a
 *  node by CPU share would imply a cost it does not have. */
export default function PlanNode({ data, selected }) {
  const { node, share, logical, label } = data;
  const b = bin(share);
  const style = logical
    ? {}
    : { background: `var(--sq${b})`, color: `var(--sq${b}-ink)`, borderColor: "transparent" };

  return (
    <div className={`pnode${logical ? " logical" : ""}${selected ? " sel" : ""}`}
         style={{ ...style, position: "relative" }}>
      <Handle type="target" position={Position.Bottom} />
      <div className="t1"><span>{icon(node.kind)}</span>{node.kind}</div>
      {label ? <div className="t2">{label}</div> : null}
      {node.metrics ? (
        <div className="t3">
          {share >= 0.1 ? `${num(share, 1)}% · ` : ""}{ms((node.metrics.total_time_ns ?? 0) / 1e6)}
        </div>
      ) : null}
      {!logical && node.metrics ? (
        <span className="status"
              title={node.metrics.done ? "Completed" : "Unfinished at snapshot"}
              style={{ background: node.metrics.done ? "var(--good)" : "var(--warn)" }} />
      ) : null}
      <Handle type="source" position={Position.Top} />
    </div>
  );
}
