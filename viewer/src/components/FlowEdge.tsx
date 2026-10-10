import { useEffect, useRef } from "react";
import { getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";
import { useLiveEdge } from "../hooks/useLive";


const STEP = 9.1;
const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A plan edge whose dots move while rows flow; the speed changes on the running animation, so they never jump. */
export default function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
                                   style, label: ended, markerEnd, interactionWidth = 20 }: EdgeProps<Edge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const line = useRef<SVGPathElement>(null);
  const motion = useRef<Animation | null>(null);
  const now = useLiveEdge(id);
  const rate = now?.rate;
  const label = now && ended !== undefined ? now.label : ended;
  const width = rate !== undefined ? { strokeWidth: Math.max(2.5, now!.width) } : now ? { ...style, strokeWidth: now.width } : style;

  useEffect(() => {
    if (rate === undefined || still()) {
      motion.current?.cancel();
      motion.current = null;
      return;
    }
    if (motion.current?.playState !== "running") {
      motion.current = line.current?.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -STEP }], {
        duration: 1000,
        iterations: Infinity,
      }) ?? null;
    }
    motion.current?.updatePlaybackRate(rate);
  }, [rate]);

  useEffect(() => () => {
    motion.current?.cancel();
    motion.current = null;
  }, []);

  return (
    <>
      <path ref={line} id={id} d={path} fill="none" className={rate !== undefined ? "react-flow__edge-path flowing" : "react-flow__edge-path"}
            style={width} markerEnd={markerEnd} />
      <path d={path} fill="none" strokeOpacity={0} strokeWidth={interactionWidth} className="react-flow__edge-interaction" />
      {label != null && (
        <text x={labelX} y={labelY} className="edge-label" textAnchor="middle" dominantBaseline="central">{label}</text>
      )}
    </>
  );
}
