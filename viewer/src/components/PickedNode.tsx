import type { Finding, PlanNode, Profile } from "../model/profile";
import { cpuMs } from "../lib/graph";
import { span } from "../lib/format";
import { replayEnd, type Moment } from "../lib/replay";
import { findNode, type NodeRef } from "../state/viewer";
import NodeDetails from "./NodeDetails";

const TOP = 6;

interface Props {
  profile: Profile | null;
  node: NodeRef | null;
  moment: Moment | null;
  physical: PlanNode[];
  findings: Map<number, Finding[]>;
  onPick: (id: number) => void;
}

export default function PickedNode({ profile, node, moment, physical, findings, onPick }: Props) {
  const picked = findNode(profile, node);
  const onPhysical = node?.plan === "physical";
  if (!picked && physical.length) return <Overview physical={physical} findings={findings} onPick={onPick} />;
  return (
    <NodeDetails node={onPhysical && moment ? (physical.find((n) => n.id === picked?.id) ?? picked) : picked}
                 plan={onPhysical ? physical : undefined}
                 findings={onPhysical && node ? findings.get(node.id) : undefined}
                 recorded={onPhysical && profile?.replay && picked
                   ? { replay: profile.replay, final: picked, end: replayEnd(profile), t: moment?.t ?? null } : undefined} />
  );
}

function Overview({ physical, findings, onPick }: { physical: PlanNode[]; findings: Map<number, Finding[]>; onPick: (id: number) => void }) {
  const total = physical.reduce((sum, n) => sum + cpuMs(n), 0);
  const top = physical.filter((n) => cpuMs(n) > 0).sort((a, b) => cpuMs(b) - cpuMs(a)).slice(0, TOP);
  const rules = new Map<string, { title: string; level: string; nodes: number[] }>();
  for (const list of findings.values()) {
    for (const f of list) {
      if (f.kind !== "problem") continue;
      const seen = rules.get(f.rule) ?? { title: f.title, level: f.level, nodes: [] };
      seen.nodes.push(f.node_id);
      rules.set(f.rule, seen);
    }
  }
  return (
    <div className="overview">
      <h3>Most CPU</h3>
      {top.length ? (
        <ul>
          {top.map((n) => (
            <li key={n.id}>
              <button onClick={() => onPick(n.id)}>
                <span className="overview-name"><b>{n.kind}</b> {n.label}</span>
                <span className="overview-ms">{span(cpuMs(n))}</span>
                <span className="overview-share" aria-hidden="true"><i style={{ width: `${(cpuMs(n) / total) * 100}%` }} /></span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="empty">No CPU recorded yet.</p>}
      {rules.size ? (
        <>
          <h3>Findings</h3>
          <ul>
            {[...rules].map(([rule, { title, level, nodes }]) => (
              <li key={rule}>
                <button className={`overview-finding overview-finding--${level}`} onClick={() => onPick(nodes[0]!)}>
                  <span className="overview-name">{title.replace(/`/g, "")}</span>
                  {nodes.length > 1 ? <span className="overview-ms">{nodes.length} nodes</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="overview-hint">Select a node for its details.</p>
    </div>
  );
}
