import { useEffect, useMemo, useRef } from "react";
import { ReactFlow, Background, MiniMap, Controls, useReactFlow } from "@xyflow/react";
import PlanNode from "./PlanNode";
import { applyView, extent, focusSteps, layout, planGraph, shareView, stepFor, toFlow } from "../lib/graph";
import { ms } from "../lib/format";
import Tip from "./Tip";

const nodeTypes = { plan: PlanNode };

export default function PlanPane({ title, plan, logical, selectedId, onSelect, focus = null, onFocus,
                                   alone, onAlone, linked, leads, onLink, channel }) {
  // Layout depends on the plan alone, so selecting a node does not re-run it.
  const positions = useMemo(() => layout(planGraph(plan)), [plan]);
  const steps = useMemo(() => focusSteps(plan), [plan]);
  const step = logical ? 0 : stepFor(steps, focus);
  const thresholdMs = steps[step].thresholdMs;
  const { nodes, edges } = useMemo(
    () => toFlow(plan, positions, { logical, selectedId, thresholdMs }),
    [plan, positions, logical, selectedId, thresholdMs],
  );
  const body = useRef(null);
  const box = useMemo(() => extent(positions), [positions]);
  const pane = logical ? "logical" : "physical";
  const size = () => ({ width: body.current?.clientWidth ?? 0, height: body.current?.clientHeight ?? 0 });
  const touched = useRef(false);
  const following = useRef(false);
  const touch = () => { touched.current = true; };

  return (
    <div className={logical ? "planbox logical" : "planbox"}>
      <div className="ph">
        <span className="nm">{title}</span>
        {onFocus && steps.length > 1 ? <Focus steps={steps} step={step} onFocus={onFocus} /> : null}
        {!alone && (
          <Tip content={linked ? "Move this plan on its own" : "Pan and zoom both plans together"}>
          <button className="pane-btn" aria-pressed={linked} onClick={onLink}
                  aria-label={linked ? "Move this plan on its own" : "Pan and zoom both plans together"}>
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none"
                 stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L5.5 8" />
              {!linked && <path d="M2.5 2.5l11 11" />}
            </svg>
          </button>
          </Tip>
        )}
        <Tip content={alone ? "Show both plans" : `Show only the ${title.toLowerCase()}`}>
        <button className="pane-btn" aria-pressed={alone} onClick={onAlone}
                aria-label={alone ? "Show both plans" : `Show only the ${title.toLowerCase()}`}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none"
               stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {alone
              ? <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M2.5 2.5l4 4M13.5 13.5l-4-4" />
              : <path d="M2.5 6.5v-4h4M13.5 9.5v4h-4M2.5 2.5l4 4M13.5 13.5l-4-4" />}
          </svg>
        </button>
        </Tip>
      </div>
      <div className="body" ref={body} onPointerDownCapture={touch} onWheelCapture={touch} onKeyDownCapture={touch}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.05}
          nodesDraggable={false}
          nodesConnectable={false}
          onMove={(_, viewport) => {
            if (linked && touched.current && !following.current) {
              channel.publish({ ...shareView(viewport, size(), box), from: pane });
            }
          }}
          onNodesChange={(changes) => {
            const picked = changes.find((c) => c.type === "select" && c.selected);
            if (picked) onSelect(Number(picked.id));
          }}
        >
          <Background variant="dots" gap={16} size={1} color="var(--axis)" />
          <MiniMap pannable zoomable nodeClassName={(n) => n.className ?? ""}
                   style={{ width: 112, height: 172, border: "1px solid var(--rule-2)", borderRadius: 5 }} />
          <Controls showInteractive={false} />
          <Refit when={alone} />
          <Follow linked={linked} leads={leads} channel={channel} pane={pane} box={box} size={size} following={following} />
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
      <Tip content={text}><span className="focus-val">{text}</span></Tip>
      <input id="plan-focus" type="range" min={0} max={steps.length - 1} step={1} value={step}
             aria-label="Focus on the most expensive nodes" aria-valuetext={text}
             onChange={(e) => {
               const next = Number(e.target.value);
               onFocus(next === 0 ? null : steps[next].coverage);
             }} />
    </label>
  );
}

function Refit({ when }) {
  const { fitView } = useReactFlow();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => fitView({ duration: 200 }));
    return () => cancelAnimationFrame(frame);
  }, [when, fitView]);
  return null;
}

function Follow({ linked, leads, channel, pane, box, size, following }) {
  const { getViewport, setViewport } = useReactFlow();
  const was = useRef(linked);
  useEffect(() => {
    if (!linked) return;
    return channel.subscribe((view) => {
      if (view.from === pane) return;
      following.current = true;
      try {
        setViewport(applyView(view, size(), box));
      } finally {
        following.current = false;
      }
    });
  }, [linked, channel, pane, box]);
  useEffect(() => {
    const starting = linked && !was.current && leads;
    was.current = linked;
    if (!starting) return;
    const frame = requestAnimationFrame(() => channel.publish({ ...shareView(getViewport(), size(), box), from: pane }));
    return () => cancelAnimationFrame(frame);
  }, [linked]);
  return null;
}
