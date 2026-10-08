import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, Background, BackgroundVariant, MiniMap, Controls, useReactFlow, useStore, type Node, type NodeSelectionChange,
} from "@xyflow/react";
import PlanNode from "./PlanNode";
import type { Finding, PlanNode as PlanNodeData } from "../model/profile";
import type { Channel, Pane } from "../hooks/usePanes";
import {
  FAR_ZOOM, NODE_H, NODE_W, applyView, distant, extent, focusSteps, shareView, startsFar, stepFor, toFlow, withSelection,
  type Box, type FocusStep, type Positions,
} from "../lib/graph";
import useLayout from "../hooks/useLayout";
import { span } from "../lib/format";
import Tip from "./Tip";

const nodeTypes = { plan: PlanNode };

type Reveal = { id: number } | null;

interface Shared {
  plan: PlanNodeData[];
  logical: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  alone: boolean;
  linked: boolean;
  leads: boolean;
  channel: Channel;
  findings?: Map<number, Finding[]>;
  reveal?: Reveal;
}

interface Props extends Shared {
  title: string;
  focus?: number | null;
  onFocus?: (focus: number | null) => void;
  onAlone: () => void;
  onLink: () => void;
  warnings?: number[];
  onWarning?: (id: number) => void;
}

export default function PlanPane({ title, plan, logical, selectedId, onSelect, focus = null, onFocus,
                                   alone, onAlone, linked, leads, onLink, channel, findings, reveal,
                                   warnings = [], onWarning }: Props) {
  const positions = useLayout(plan);
  const steps = useMemo(() => focusSteps(plan), [plan]);
  const step = logical ? 0 : stepFor(steps, focus);
  const thresholdMs = steps[step]!.thresholdMs;
  const view = { plan, positions, logical, selectedId, onSelect, thresholdMs, alone, linked, leads, channel, findings, reveal };

  return (
    <div className={logical ? "planbox logical" : "planbox"}>
      <div className="ph">
        <span className="nm">{title}</span>
        {warnings.length && onWarning ? <Warnings ids={warnings} selectedId={selectedId} onPick={onWarning} /> : null}
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
      {positions
        ? <PlanView {...view} positions={positions} />
        : <div className="body laying-out" role="status">Laying out {plan.length.toLocaleString("en-US")} nodes…</div>}
    </div>
  );
}

function PlanView({ plan, positions, logical, selectedId, onSelect, thresholdMs, alone, linked, leads, channel,
                    findings, reveal = null }: Shared & { positions: Positions; thresholdMs: number }) {
  const flow = useMemo(
    () => toFlow(plan, positions, { logical, selectedId: null, thresholdMs, findings }),
    [plan, positions, logical, thresholdMs, findings],
  );
  const box = useMemo(() => extent(positions), [positions]);
  const [far, setFar] = useState(() => startsFar(box));
  const [fitted, setFitted] = useState(false);
  const seen = useMemo(() => (far ? distant(flow) : flow), [flow, far]);
  const { nodes, edges } = useMemo(() => withSelection(seen, selectedId), [seen, selectedId]);
  const body = useRef<HTMLDivElement>(null);
  const pane: Pane = logical ? "logical" : "physical";
  const size = () => ({ width: body.current?.clientWidth ?? 0, height: body.current?.clientHeight ?? 0 });
  const touched = useRef(false);
  const following = useRef(false);
  const touch = () => { touched.current = true; };

  return (
    <div className="body" ref={body} onPointerDownCapture={touch} onWheelCapture={touch} onKeyDownCapture={touch}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.01}
        nodesDraggable={false}
        nodesConnectable={false}
        onlyRenderVisibleElements={fitted}
        onMove={(_, viewport) => {
          if (linked && touched.current && !following.current) {
            channel.publish({ ...shareView(viewport, size(), box), from: pane });
          }
        }}
        onNodesChange={(changes) => {
          const picked = changes.find((c): c is NodeSelectionChange => c.type === "select" && c.selected);
          if (picked) onSelect(Number(picked.id));
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--axis)" />
        <MiniMap pannable zoomable nodeClassName={(n: Node) => n.className ?? ""} style={{ width: 112, height: 172 }} />
        <Controls showInteractive={false} />
        <Refit when={alone} />
        <Distance onChange={setFar} onFitted={setFitted} />
        <Reveal request={reveal} positions={positions} />
        <Follow linked={linked} leads={leads} channel={channel} pane={pane} box={box} size={size} following={following} />
      </ReactFlow>
    </div>
  );
}

function Warnings({ ids, selectedId, onPick }: { ids: number[]; selectedId: number | null; onPick: (id: number) => void }) {
  const at = selectedId === null ? -1 : ids.indexOf(selectedId);
  const go = (by: number) => {
    const from = at >= 0 ? at : by > 0 ? -1 : 0;
    onPick(ids[(from + by + ids.length) % ids.length]!);
  };
  const label = at >= 0 ? `Warning ${at + 1} of ${ids.length}` : `${ids.length} warning${ids.length > 1 ? "s" : ""}`;
  const chevron = (d: string) => (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  );
  return (
    <div className="warn-nav" role="group" aria-label="Warnings">
      <Tip content="Previous warning">
        <button className="pane-btn" onClick={() => go(-1)} aria-label="Previous warning">{chevron("M10 3.5L5.5 8l4.5 4.5")}</button>
      </Tip>
      <Tip content={label}>
        <span className="warn-count" aria-live="polite" aria-label={label} tabIndex={0}>
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor"
               strokeWidth="1.6" strokeLinejoin="round"><path d="M8 2.5l6 10.5H2z M8 6.5v3 M8 11v.5" /></svg>
          {at >= 0 ? `${at + 1}/${ids.length}` : ids.length}
        </span>
      </Tip>
      <Tip content="Next warning">
        <button className="pane-btn" onClick={() => go(1)} aria-label="Next warning">{chevron("M6 3.5L10.5 8 6 12.5")}</button>
      </Tip>
    </div>
  );
}

/** Light only the most expensive nodes; each step takes away the cheapest. */
function Focus({ steps, step, onFocus }: { steps: FocusStep[]; step: number; onFocus: (focus: number | null) => void }) {
  const { coverage, shown, thresholdMs } = steps[step]!;
  const total = steps[0]!.shown;
  const text = step === 0
    ? `all ${total} nodes`
    : `${shown} of ${total} · ${Math.round(coverage)}% of CPU · ≥ ${span(thresholdMs)}`;
  return (
    <label className="focus">
      <Tip content={text}><span className="focus-val">{text}</span></Tip>
      <input id="plan-focus" type="range" min={0} max={steps.length - 1} step={1} value={step}
             aria-label="Focus on the most expensive nodes" aria-valuetext={text}
             onChange={(e) => {
               const next = Number(e.target.value);
               onFocus(next === 0 ? null : steps[next]!.coverage);
             }} />
    </label>
  );
}

function Refit({ when }: { when: boolean }) {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const first = useRef(true);
  const pending = useRef(false);
  const size = useRef({ width, height });
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    pending.current = true;
  }, [when]);
  useEffect(() => {
    const resized = size.current.width !== width || size.current.height !== height;
    size.current = { width, height };
    if (!resized || !pending.current) return;
    pending.current = false;
    fitView({ duration: 200 });
  }, [width, height, fitView]);
  return null;
}

interface FollowProps {
  linked: boolean;
  leads: boolean;
  channel: Channel;
  pane: Pane;
  box: Box;
  size: () => { width: number; height: number };
  following: { current: boolean };
}

function Follow({ linked, leads, channel, pane, box, size, following }: FollowProps) {
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

function Distance({ onChange, onFitted }: { onChange: (far: boolean) => void; onFitted: (fitted: boolean) => void }) {
  const far = useStore((s) => {
    const [x, y, zoom] = s.transform;
    return x === 0 && y === 0 && zoom === 1 ? null : zoom < FAR_ZOOM;
  });
  useEffect(() => {
    if (far === null) return;
    onChange(far);
    onFitted(true);
  }, [far, onChange, onFitted]);
  return null;
}

/** Centre a node the header asked to see, close enough to read it. */
function Reveal({ request, positions }: { request: Reveal; positions: Positions }) {
  const { getZoom, setCenter } = useReactFlow();
  useEffect(() => {
    const at = request && positions[String(request.id)];
    if (!at) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setCenter(at.x + NODE_W / 2, at.y + NODE_H / 2, { zoom: Math.max(getZoom(), 0.7), duration: still ? 0 : 400 });
  }, [request]);
  return null;
}
