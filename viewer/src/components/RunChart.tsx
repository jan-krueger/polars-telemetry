import { useId } from "react";
import { span } from "../lib/format";
import type { Stretch } from "../lib/replay";

interface Props {
  stretches: Stretch[];
  end: number;
  peak: number;
  /** The replayed moment: what lies after it is drawn paler. */
  t: number | null;
  /** Lowest bar, as a share of the height, so a running but idle stretch still shows. */
  floor?: number;
  marker?: boolean;
  titles?: boolean;
}

/** Threads kept busy per stretch between samples, as bars over the run. */
export default function RunChart({ stretches, end, peak, t, floor = 0, marker = true, titles = false }: Props) {
  const clip = useId();
  const x = (ms: number) => (end > 0 ? (ms / end) * 1000 : 0);
  const bars = stretches.map((s) => {
    const h = Math.max(floor, Math.min(100, (s.load / peak) * 100));
    return (
      <rect key={s.from} x={x(s.from)} width={x(s.to) - x(s.from)} y={100 - h} height={h}>
        {titles ? <title>{`${span(s.from)}–${span(s.to)}: ${s.load.toFixed(1)} threads`}</title> : null}
      </rect>
    );
  });
  return (
    <svg className="run-chart" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden={!titles}>
      {t !== null && (
        <>
          <clipPath id={clip}><rect x={0} y={0} width={x(t)} height={100} /></clipPath>
          <g className="run-ahead">{bars}</g>
        </>
      )}
      <g className="run-past" clipPath={t !== null ? `url(#${clip})` : undefined}>{bars}</g>
      {marker && t !== null && <line className="run-at" x1={x(t)} x2={x(t)} y1={0} y2={100} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
