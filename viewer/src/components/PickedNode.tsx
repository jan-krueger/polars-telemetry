import type { Finding, PlanNode, Profile } from "../model/profile";
import { replayEnd, type Moment } from "../lib/replay";
import { findNode, type NodeRef } from "../state/viewer";
import NodeDetails from "./NodeDetails";

interface Props {
  profile: Profile | null;
  node: NodeRef | null;
  moment: Moment | null;
  physical: PlanNode[];
  findings: Map<number, Finding[]>;
}

export default function PickedNode({ profile, node, moment, physical, findings }: Props) {
  const picked = findNode(profile, node);
  const onPhysical = node?.plan === "physical";
  return (
    <NodeDetails node={onPhysical && moment ? (physical.find((n) => n.id === picked?.id) ?? picked) : picked}
                 plan={onPhysical ? physical : undefined}
                 findings={onPhysical && node ? findings.get(node.id) : undefined}
                 recorded={onPhysical && profile?.replay && picked
                   ? { replay: profile.replay, final: picked, end: replayEnd(profile), t: moment?.t ?? null } : undefined} />
  );
}
