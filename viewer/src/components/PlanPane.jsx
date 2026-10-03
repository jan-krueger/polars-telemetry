import { useMemo } from "react";
import { ReactFlow, Background, MiniMap, Controls } from "@xyflow/react";
import PlanNode from "./PlanNode";
import { focusSteps, layout, planGraph, stepFor, toFlow } from "../lib/graph";
import { ms } from "../lib/format";

const nodeTypes = { plan: PlanNode };

export default function PlanPane({ title, plan, logical, selectedId, onSelect, focus = null, onFocus }) {
  // Layout depends on the plan alone, so selecting a node does not re-run it.
  const positions = useMemo(() => layout(planGraph(plan)), [plan]);
  const steps = useMemo(() => focusSteps(plan), [plan]);
  const step = logical ? 0 : stepFor(steps, focus);
  const thresholdMs = steps[step].thresholdMs;
  const { nodes, edges } = useMemo(
    () => toFlow(plan, positions, { logical, selectedId, thresholdMs }),
    [plan, positions, logical, selectedId, thresholdMs],
  );

  return (
    <div className={logical ? "planbox logical" : "planbox"}>
      <div className="ph">
        <span className="nm">{title}</span>
        {onFocus && steps.length > 1 ? <Focus steps={steps} step={step} onFocus={onFocus} /> : null}
      </div>
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
          <MiniMap pannable zoomable nodeClassName={(n) => n.className ?? ""}
                   style={{ width: 112, height: 172, border: "1px solid var(--rule-2)", borderRadius: 5 }} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}

/** Light only the most expensive nodes; each step takes away the cheapest. */
function Focus({ steps, step, onFocus }) {
  const { coverage, shown, thresholdMs } = steps[step];
  const total = steps[0].shown;
  const text = step === 0
    ? `all ${total} nodes`
    : `${shown} of ${total} · ${Math.round(coverage)}% of CPU · ≥ ${ms(thresholdMs)}`;
  return (
    <label className="focus">
      <span className="focus-val" title={text}>{text}</span>
      <input id="plan-focus" type="range" min={0} max={steps.length - 1} step={1} value={step}
             aria-label="Focus on the most expensive nodes" aria-valuetext={text}
             onChange={(e) => {
               const next = Number(e.target.value);
               onFocus(next === 0 ? null : steps[next].coverage);
             }} />
    </label>
  );
}
