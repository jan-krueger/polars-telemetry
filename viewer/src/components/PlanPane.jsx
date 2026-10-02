import { useMemo } from "react";
import { ReactFlow, Background, MiniMap, Controls } from "@xyflow/react";
import PlanNode from "./PlanNode";
import { NODE_H, NODE_W, layout } from "../lib/layout";
import { cpuMs, rows as fmtRows } from "../lib/format";

const nodeTypes = { plan: PlanNode };

function nodeLabel(n) {
  const p = n.properties || {};
  if (p.first_source) return String(p.first_source).split("/").pop() + (p.predicate ? " · pushdown" : "");
  if (p.how) return String(p.how);
  if (p.keys) return p.keys.map((x) => String(x).slice(4, -1).replace(/"/g, "")).join(", ");
  if (p.sort_columns?.length) return String(p.sort_columns[0].expr).slice(4, -1).replace(/"/g, "");
  if (p.columns) return `${p.columns.length} cols`;
  return "";
}

export default function PlanPane({ title, subtitle, plan, logical, selectedId, onSelect }) {
  const { nodes, edges } = useMemo(() => {
    const pos = layout(plan);
    const total = plan.reduce((a, n) => a + cpuMs(n), 0) || 1;
    const byId = Object.fromEntries(plan.map((n) => [n.id, n]));
    const nodes = plan.map((n) => ({
      id: String(n.id),
      type: "plan",
      position: pos[n.id],
      // The minimap and bounds helpers read dimensions off the node object we
      // pass in, never the measured DOM, so an unsized node is skipped there.
      width: NODE_W,
      height: NODE_H,
      selected: selectedId === n.id,
      data: { node: n, share: (cpuMs(n) / total) * 100, logical, label: nodeLabel(n) },
    }));
    const edges = [];
    for (const n of plan)
      for (const input of n.inputs) {
        if (!byId[input]) continue;
        const r = logical ? null : byId[input].metrics?.rows_sent;
        edges.push({
          id: `${input}-${n.id}`,
          source: String(input),
          target: String(n.id),
          label: r == null ? undefined : `${fmtRows(r)} rows`,
          animated: false,
          style: logical ? { stroke: "var(--axis)", strokeDasharray: "4 3" } : { stroke: "var(--axis)" },
        });
      }
    return { nodes, edges };
  }, [plan, logical, selectedId]);

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
