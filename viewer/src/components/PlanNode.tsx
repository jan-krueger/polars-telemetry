import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ROLES, relationName, roleOf } from "../lib/polars";
import { num, span } from "../lib/format";
import { cpuMs, type FlowData } from "../lib/graph";
import Tip, { TipText } from "./Tip";

const bin = (p: number): number => (p >= 50 ? 4 : p >= 10 ? 3 : p >= 1 ? 2 : 1);

// Logical nodes have no counters: outlined, never filled by CPU share.
export default function PlanNode({ data, selected }: NodeProps<Node<FlowData>>) {
  const { node, share, logical, label, far, finding } = data;
  const role = roleOf(node);
  const info = ROLES[role];
  const relation = role === "scan" ? relationName(node.properties ?? {}) : "";
  const title = relation || node.kind;
  const className = `pnode${logical ? " logical" : ` pnode--b${bin(share)}`}${selected ? " pnode--sel" : ""}`;

  if (far) {
    return (
      <div className={className}>
        <Handle type="target" position={Position.Bottom} />
        <Handle type="source" position={Position.Top} />
      </div>
    );
  }

  return (
    <div className={className}>
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
          <span className={node.metrics.done ? "status status--done" : "status status--open"} />
        </Tip>
      ) : null}
      <Handle type="source" position={Position.Top} />
    </div>
  );
}
