import { useEffect, useRef } from "react";
import { getBezierPath, type Edge, type EdgeProps } from "@xyflow/react";

type FlowEdgeData = { rate?: number };

const STEP = 9.1;
const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A plan edge whose dots move while rows flow; the speed changes on the running animation, so they never jump. */
export default function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
                                   data, style, label, markerEnd, interactionWidth = 20 }: EdgeProps<Edge<FlowEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const line = useRef<SVGPathElement>(null);
  const motion = useRef<Animation | null>(null);
  const rate = data?.rate;

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
      <path ref={line} id={id} d={path} fill="none" className="react-flow__edge-path" style={style} markerEnd={markerEnd} />
      <path d={path} fill="none" strokeOpacity={0} strokeWidth={interactionWidth} className="react-flow__edge-interaction" />
      {label != null && (
        <text x={labelX} y={labelY} className="edge-label" textAnchor="middle" dominantBaseline="central">{label}</text>
      )}
    </>
  );
}
