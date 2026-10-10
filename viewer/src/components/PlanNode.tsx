import { memo, type ReactElement } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ROLES, roleOf, type MarkKind } from "../lib/polars";
import { num, span } from "../lib/format";
import { cpuMs, type FlowData } from "../lib/graph";
import { useLiveNode } from "../hooks/useLive";
import Tip, { TipText } from "./Tip";

const bin = (p: number): number => (p >= 50 ? 4 : p >= 10 ? 3 : p >= 1 ? 2 : 1);

const ICONS: Record<MarkKind | "open", ReactElement> = {
  filter: <path d="M1 1.5h10L7.2 6v4L4.8 11V6z" fill="currentColor" />,
  columns: (
    <>
      <rect x="1" y="1" width="2.4" height="10" rx=".6" fill="currentColor" />
      <rect x="4.8" y="1" width="2.4" height="10" rx=".6" fill="currentColor" opacity=".35" />
      <rect x="8.6" y="1" width="2.4" height="10" rx=".6" fill="currentColor" />
    </>
  ),
  limit: (
    <>
      <path d="M1.5 2.5h9M1.5 5.5h9M1.5 8.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M8 8.5h3" stroke="currentColor" strokeWidth="1.6" strokeDasharray="1 1.4" />
    </>
  ),
  skip: (
    <>
      <path d="M2 2h5v8H2z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 6h6M9 4l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </>
  ),
  open: (
    <>
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 6V1.4A4.6 4.6 0 0 1 10.6 6z" fill="currentColor" />
    </>
  ),
};

function Mark({ kind, name, detail, tone }: { kind: MarkKind | "open"; name: string; detail: string; tone?: string }) {
  return (
    <Tip content={<TipText term={name}>{detail ? <code>{detail}</code> : null}</TipText>}>
      <span className={`pmark${tone ? ` pmark--${tone}` : ""}`} tabIndex={0} aria-label={name}>
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">{ICONS[kind]}</svg>
      </span>
    </Tip>
  );
}

// Logical nodes have no counters: outlined, never filled by CPU share.
function PlanNode({ id, data, selected }: NodeProps<Node<FlowData>>) {
  const now = useLiveNode(id);
  const { logical, label, far, finding } = data;
  const node = now?.node ?? data.node;
  const share = now?.share ?? data.share;
  const live = now?.state;
  const role = roleOf(node);
  const info = ROLES[role];
  const { variant, marks } = node;
  const open = !logical && !live && node.metrics?.done === false;
  const className = `pnode${logical ? " logical" : ` pnode--b${bin(share)}`}${selected ? " pnode--sel" : ""}`
    + (live === "waiting" ? " pnode--waiting" : "");

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
      <div className="phead">
        <div className="t1">
          {info.symbol ? <span className={`ra${info.muted ? " ra--muted" : ""}`}>{info.symbol}</span> : null}
          <span className="t1-kind">{node.kind}</span>
          {variant ? <span className="t1-var">· {variant}</span> : null}
        </div>
        {marks.length || finding || open ? (
          <div className="pmarks">
            {marks.map((m) => <Mark key={m.kind} {...m} />)}
            {finding ? (
              <span className={`pflag pflag--${finding}`} aria-label={finding === "warn" ? "Warning" : "Information"}>
                {finding === "warn"
                  ? <svg viewBox="0 0 12 11" width="12" height="11" aria-hidden="true"><path d="M6 .8 11.4 10.2H.6Z" fill="currentColor" /><path d="M6 4v3M6 8.4v.2" stroke="var(--surface)" strokeWidth="1.4" strokeLinecap="round" /></svg>
                  : <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>}
              </span>
            ) : null}
            {open ? <Mark kind="open" name="done = false" detail="" tone="warn" /> : null}
          </div>
        ) : null}
      </div>
      <div className={role === "selection" ? "t2 t2--code" : "t2"} title={label || undefined}>{label}</div>
      {node.metrics ? (
        <div className="t3">
          {share >= 0.1 ? `${num(share, 1)}% · ` : ""}{span(cpuMs(node))}
        </div>
      ) : null}
      <Handle type="source" position={Position.Top} />
    </div>
  );
}

export default memo(PlanNode);
