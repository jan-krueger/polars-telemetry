import { useMemo } from "react";
import { ReactFlow, Background, MiniMap, Controls } from "@xyflow/react";
import PlanNode from "./PlanNode";
import { layout, planGraph, toFlow } from "../lib/graph";

const nodeTypes = { plan: PlanNode };

export default function PlanPane({ title, subtitle, plan, logical, selectedId, onSelect }) {
  // Layout depends on the plan alone, so selecting a node does not re-run it.
  const positions = useMemo(() => layout(planGraph(plan)), [plan]);
  const { nodes, edges } = useMemo(
    () => toFlow(plan, positions, { logical, selectedId }),
    [plan, positions, logical, selectedId],
  );

  return (
    <div className="planbox">
      <div className="ph"><span className="nm">{title}</span><span className="sub">{subtitle}</span></div>
      <div className="body">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.05}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, n) => onSelect(Number(n.id))}
        >
          <Background variant="dots" gap={16} size={1} color="var(--axis)" />
          <MiniMap pannable zoomable className={logical ? "logical" : undefined}
                   style={{ width: 112, height: 172 }} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
