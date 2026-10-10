import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow, Background, BackgroundVariant, MiniMap, Controls, useReactFlow, useStore, type Node, type NodeChange, type NodeSelectionChange, type Viewport,
} from "@xyflow/react";
import PlanNode from "./PlanNode";
import FlowEdge from "./FlowEdge";
import type { Moment } from "../lib/replay";
import type { Finding, PlanNode as PlanNodeData } from "../model/profile";
import type { Channel, Pane } from "../hooks/usePanes";
import {
  FAR_ZOOM, NODE_H, NODE_W, applyView, cpuMs, distant, extent, focusSteps, liveFlow, shareView, startsFar, stepFor, toFlow, withSelection,
  type Box, type FocusStep, type Positions,
} from "../lib/graph";
import useLayout from "../hooks/useLayout";
import { LiveContext, LiveStore } from "../hooks/useLive";
import { span } from "../lib/format";
import Tip from "./Tip";

const nodeTypes = { plan: PlanNode };
const edgeTypes = { flow: FlowEdge };
const MINI = { width: 112, height: 172 };
const READABLE = 0.7;
const UNREADABLE = 0.4;
const miniClass = (n: Node): string => n.className ?? "";

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
  /** While replaying, the counters at that moment; the layout and focus steps stay those of the whole run. */
  moment?: Moment | null;
}

interface Props extends Shared {
  title: string;
  switcher?: ReactNode;
  focus?: number | null;
  onFocus?: (focus: number | null) => void;
  onAlone: () => void;
  onLink: () => void;
  warnings?: number[];
  onWarning?: (id: number) => void;
}

export default function PlanPane({ title, switcher, plan, logical, selectedId, onSelect, focus = null, onFocus,
                                   alone, onAlone, linked, leads, onLink, channel, findings, reveal, moment,
                                   warnings = [], onWarning }: Props) {
  const positions = useLayout(plan);
  const steps = useMemo(() => focusSteps(plan), [plan]);
  const step = logical ? 0 : stepFor(steps, focus);
  const thresholdMs = steps[step]!.thresholdMs;
  const view = { plan, positions, logical, selectedId, onSelect, thresholdMs, alone, linked, leads, channel, findings, reveal, moment };

  return (
    <div className={logical ? "planbox logical" : "planbox"}>
      <div className="ph">
        {switcher ?? <span className="nm">{title}</span>}
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
                    findings, reveal = null, moment = null }: Shared & { positions: Positions; thresholdMs: number }) {
  const flow = useMemo(
    () => toFlow(plan, positions, { logical, selectedId: null, thresholdMs, findings }),
    [plan, positions, logical, thresholdMs, findings],
  );
  const live = useMemo(() => new LiveStore(), []);
  useLayoutEffect(() => {
    live.set(moment && !logical ? liveFlow(plan, moment, live.current()) : null);
  }, [live, plan, moment, logical]);
  const box = useMemo(() => extent(positions), [positions]);
  const home = useMemo(() => start(plan, positions), [plan, positions]);
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
  const latest = useRef({ linked, channel, pane, box, onSelect });
  latest.current = { linked, channel, pane, box, onSelect };
  const onMove = useCallback((_: unknown, viewport: Viewport) => {
    const { linked, channel, pane, box } = latest.current;
    if (linked && touched.current && !following.current) channel.publish({ ...shareView(viewport, size(), box), from: pane });
  }, []);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const picked = changes.find((c): c is NodeSelectionChange => c.type === "select" && c.selected);
    if (picked) latest.current.onSelect(Number(picked.id));
  }, []);

  return (
    <div className="body" ref={body} onPointerDownCapture={touch} onWheelCapture={touch} onKeyDownCapture={touch}>
      <LiveContext.Provider value={live}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.01}
          nodesDraggable={false}
          nodesConnectable={false}
          onlyRenderVisibleElements={fitted}
          onMove={onMove}
          onNodesChange={onNodesChange}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--axis)" />
          <MiniMap pannable zoomable nodeClassName={miniClass} style={MINI} />
          <Controls showInteractive={false} />
          <Home when={alone} box={box} target={home} />
          <InView id={selectedId} positions={positions} />
          <Distance onChange={setFar} onFitted={setFitted} />
          <Reveal request={reveal} positions={positions} />
          <Follow linked={linked} leads={leads} channel={channel} pane={pane} box={box} size={size} following={following} />
        </ReactFlow>
      </LiveContext.Provider>
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

/** Where a plan too large to read whole opens: its most expensive node, else its top. */
function start(plan: PlanNodeData[], positions: Positions): { x: number; y: number } | null {
  const hottest = plan.reduce<PlanNodeData | null>((best, n) => (cpuMs(n) > (best ? cpuMs(best) : 0) ? n : best), null);
  const at = hottest ? positions[String(hottest.id)] : Object.values(positions).reduce<{ x: number; y: number } | undefined>((top, p) => (!top || p.y < top.y ? p : top), undefined);
  return at ? { x: at.x + NODE_W / 2, y: at.y + NODE_H / 2 } : null;
}

function Home({ when, box, target }: { when: boolean; box: Box; target: { x: number; y: number } | null }) {
  const { fitView, setCenter } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const placed = useRef(false);
  const pending = useRef(false);
  const size = useRef({ width, height });
  useEffect(() => {
    if (placed.current) pending.current = true;
  }, [when]);
  useEffect(() => {
    const resized = size.current.width !== width || size.current.height !== height;
    size.current = { width, height };
    if (!width || !height || (placed.current && !(resized && pending.current))) return;
    const duration = placed.current ? 200 : 0;
    placed.current = true;
    pending.current = false;
    const fit = Math.min(width / box.width, height / box.height) * 0.9;
    if (fit >= UNREADABLE || !target) fitView({ duration });
    else setCenter(target.x, target.y, { zoom: READABLE, duration });
  }, [width, height, box, target, fitView, setCenter]);
  return null;
}

function InView({ id, positions }: { id: number | null; positions: Positions }) {
  const { getViewport, setCenter } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    const at = id === null ? undefined : positions[String(id)];
    if (!at || !width) return;
    const { x, y, zoom } = getViewport();
    const left = at.x * zoom + x, top = at.y * zoom + y;
    if (left >= 0 && top >= 0 && left + NODE_W * zoom <= width && top + NODE_H * zoom <= height) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setCenter(at.x + NODE_W / 2, at.y + NODE_H / 2, { zoom: Math.max(zoom, READABLE), duration: still ? 0 : 400 });
  }, [id]);
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

function Reveal({ request, positions }: { request: Reveal; positions: Positions }) {
  const { getZoom, setCenter } = useReactFlow();
  useEffect(() => {
    const at = request && positions[String(request.id)];
    if (!at) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setCenter(at.x + NODE_W / 2, at.y + NODE_H / 2, { zoom: Math.max(getZoom(), READABLE), duration: still ? 0 : 400 });
  }, [request]);
  return null;
}
