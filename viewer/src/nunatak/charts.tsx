import { useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { span } from "../lib/format";
import type { Day, QueryOverview, QuerySummary } from "./api";
import { when } from "./words";

export type Range = [number, number];

const tone = (q: QueryOverview): string => (q.verdict === "slower" ? "slow" : q.verdict === "faster" ? "fast" : "plain");

/** A query's median time through the range, over the band its usual runs fall in. */
export function Spark({ q, range, width = 150, height = 32, scale = false }: { q: QueryOverview; range: Range; width?: number; height?: number; scale?: boolean }) {
  const values = q.bins.filter((v): v is number => v !== null);
  if (values.length < 2) return <span className="dim">–</span>;
  const top = scale ? 11 : 3;
  const max = Math.max(...values, ...(q.usual_band_ms ?? [])) * 1.1;
  const x = (i: number) => ((i + 0.5) / q.bins.length) * width;
  const y = (v: number) => height - 3 - (v / max) * (height - 3 - top);
  let path = "";
  q.bins.forEach((v, i) => {
    if (v !== null) path += `${path ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  const last = q.bins.reduce<number>((found, v, i) => (v === null ? found : i), -1);
  const changed = q.plan_changed_unix_ns !== null && q.plan_changed_unix_ns >= range[0]
    ? ((q.plan_changed_unix_ns - range[0]) / (range[1] - range[0])) * width : null;
  return (
    <svg className={`nspark nspark--${tone(q)}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
         role="img" aria-label={`Median time over the range, up to ${span(max / 1.1)}`}>
      {q.usual_band_ms && <rect className="nspark-band" x={0} width={width} y={y(q.usual_band_ms[1])} height={Math.max(1.5, y(q.usual_band_ms[0]) - y(q.usual_band_ms[1]))} />}
      {changed !== null && <line className="nspark-change" x1={changed} x2={changed} y1={top - 2} y2={height} />}
      <path className="nspark-line" d={path} />
      {last >= 0 && <circle className="nspark-end" cx={x(last)} cy={y(q.bins[last]!)} r={2.6} />}
      {scale && <text x={0} y={8}>max {span(max / 1.1)}</text>}
    </svg>
  );
}

/** A day's cell: red when its median was slower than usual, blue when faster, plain otherwise. */
export function cellStyle(day: Day, usual: number | null): CSSProperties {
  if (day.median_wall_ms === null || usual === null) return {};
  const log = Math.max(-1.6, Math.min(1.6, Math.log2(day.median_wall_ms / usual)));
  if (Math.abs(log) < 0.32) return {};
  const strength = Math.round(18 + (Math.abs(log) / 1.6) * 70);
  return { background: `color-mix(in oklab, var(${log > 0 ? "--crit" : "--accent"}) ${strength}%, var(--cell))` };
}

export interface Plan {
  fingerprint: string | null;
  name: string;
  colour: string;
  first_started_unix_ns: number;
}

/** 300 ms, 3 s, 30 s, 3 min: a round tick needs no decimals. */
const tick = (v: number): string =>
  v < 1 ? `${Math.round(v * 1000)} µs` : v < 1000 ? `${v} ms` : v < 1e6 ? `${v / 1000} s` : v < 3.6e7 ? `${Math.round(v / 60_000)} min` : `${Math.round(v / 3.6e6)} h`;

interface Point {
  run: QuerySummary;
  x: number;
  y: number;
}

type Hover = { kind: "run"; point: Point } | { kind: "plan"; plan: Plan; x: number };

/**
 * Every run's wall time on a log scale, coloured by its plan, failures on a lane at the top.
 * Each plan that started in the range is marked; hovering a mark or a run tells more, and a run opens on click.
 */
export function RunsChart({ runs, plans, range, selected, onOpen }: {
  runs: QuerySummary[];
  plans: Plan[];
  range: Range;
  selected: string | null;
  onOpen: (id: string) => void;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const failures = runs.some((r) => r.status === "failed");
  const W = 1400, H = 260, L = 60, R = 16, T = failures ? 34 : 18, B = 24;
  const walls = runs.filter((r) => r.status === "finished" && r.wall_ms !== null).map((r) => r.wall_ms!);
  const lo = Math.max(1e-3, Math.min(...walls, Infinity) / 1.5), hi = Math.max(...walls, lo * 10) * 1.5;
  const x = (ns: number) => L + ((ns - range[0]) / (range[1] - range[0])) * (W - L - R);
  const y = (v: number) => T + 12 + (1 - Math.log(v / lo) / Math.log(hi / lo)) * (H - T - B - 12);
  const ticks = [1e-3, 1e-2, 0.1, 1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7].flatMap((d) => [d, d * 3]).filter((v) => v >= lo && v <= hi);
  const plan = (r: QuerySummary) => plans.find((p) => p.fingerprint === r.fingerprint);
  const key = (fingerprint: string | null) => fingerprint ?? "-";
  const points: Point[] = runs.flatMap((run) => run.status === "failed" ? [{ run, x: x(run.started_unix_ns), y: T - 13 }]
    : run.wall_ms === null ? [] : [{ run, x: x(run.started_unix_ns), y: y(run.wall_ms) }]);
  const marks = [...plans].sort((a, b) => a.first_started_unix_ns - b.first_started_unix_ns).slice(1)
    .filter((p) => p.first_started_unix_ns >= range[0] && p.first_started_unix_ns <= range[1]);
  const span_ = (range[1] - range[0]) / 1e9;
  const labelEvery = span_ > 20 * 86_400 ? 7 : span_ > 3 * 86_400 ? 1 : 0;
  const axis = labelEvery ? dayTicks(range, labelEvery) : hourTicks(range);

  const move = (e: PointerEvent<SVGSVGElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((e.clientX - box.left) / box.width) * W, py = ((e.clientY - box.top) / box.height) * H;
    if (py < T - 4) {
      const mark = marks.find((p) => Math.abs(x(p.first_started_unix_ns) - px) < 10);
      if (mark) return setHover({ kind: "plan", plan: mark, x: x(mark.first_started_unix_ns) });
    }
    let best: Point | null = null, distance = 14 ** 2;
    for (const point of points) {
      if (selected !== null && key(point.run.fingerprint) !== selected) continue;
      const d = (point.x - px) ** 2 + (point.y - py) ** 2;
      if (d < distance) [best, distance] = [point, d];
    }
    setHover(best ? { kind: "run", point: best } : null);
  };
  const tip = hover && (hover.kind === "run"
    ? { x: hover.point.x, y: hover.point.y, body: (
        <>
          <b>{hover.point.run.status === "failed" ? "failed" : span(hover.point.run.wall_ms ?? 0)}</b>
          <span>{when(hover.point.run.started_unix_ns)}</span>
          <span className="dim">{[hover.point.run.host, plan(hover.point.run)?.name].filter(Boolean).join(" · ")}</span>
        </>
      ) }
    : { x: hover.x, y: T - 6, body: <><b>{hover.plan.name}</b><span>{when(hover.plan.first_started_unix_ns)}</span></> });

  return (
    <div className="nruns-box">
      <svg ref={svg} className={hover?.kind === "run" ? "nruns nruns--point" : "nruns"} viewBox={`0 0 ${W} ${H}`} role="img"
           aria-label="Wall time of every run, on a log scale" onPointerMove={move} onPointerLeave={() => setHover(null)}
           onClick={() => hover?.kind === "run" && onOpen(hover.point.run.query_id)}>
        {ticks.map((v) => (
          <g key={v}>
            <line className="nruns-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
            <text x={L - 8} y={y(v) + 3.5} textAnchor="end">{tick(v)}</text>
          </g>
        ))}
        {axis.map(([t, text]) => <text key={t} x={x(t)} y={H - 6} textAnchor="middle">{text}</text>)}
        {failures && <text x={L - 8} y={T - 9} textAnchor="end">failed</text>}
        {marks.map((p) => (
          <g key={key(p.fingerprint)} className={hover?.kind === "plan" && hover.plan === p ? "nruns-mark on" : "nruns-mark"}>
            <line x1={x(p.first_started_unix_ns)} x2={x(p.first_started_unix_ns)} y1={T - 4} y2={H - B} />
            <path d={`M${x(p.first_started_unix_ns) - 5},${T - 12} h10 v5 l-5,5 l-5,-5 z`} style={{ fill: p.colour }} />
          </g>
        ))}
        {points.map(({ run, x: px, y: py }) => {
          const dim = selected !== null && key(run.fingerprint) !== selected;
          return run.status === "failed"
            ? <path key={run.query_id} className={dim ? "nruns-failed dim" : "nruns-failed"} d={`M${px - 3},${py - 3} l6,6 m0,-6 l-6,6`} />
            : <circle key={run.query_id} className={dim ? "dim" : undefined} cx={px} cy={py} r={2.6} style={{ fill: plan(run)?.colour ?? "var(--muted)" }} />;
        })}
        {hover?.kind === "run" && <circle className="nruns-ring" cx={hover.point.x} cy={hover.point.y} r={6} />}
      </svg>
      {tip && (
        <div className={`nruns-tip${tip.x > W * 0.85 ? " nruns-tip--left" : tip.x < W * 0.15 ? " nruns-tip--right" : ""}`}
             style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%` }}>{tip.body}</div>
      )}
    </div>
  );
}

function dayTicks(range: Range, every: number): [number, string][] {
  const out: [number, string][] = [];
  const day = new Date(range[0] / 1e6);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; day.getTime() * 1e6 <= range[1]; i++, day.setDate(day.getDate() + 1)) {
    const at = day.getTime() * 1e6;
    if (at > range[0] && i % every === 0) out.push([at, day.toLocaleDateString(undefined, { day: "numeric", month: "short" })]);
  }
  return out;
}

function hourTicks(range: Range): [number, string][] {
  const hours = (range[1] - range[0]) / 3.6e12;
  const step = hours > 48 ? 12 : hours > 12 ? 3 : 1;
  const out: [number, string][] = [];
  const at = new Date(range[0] / 1e6);
  at.setMinutes(0, 0, 0);
  for (; at.getTime() * 1e6 <= range[1]; at.setHours(at.getHours() + 1)) {
    if (at.getTime() * 1e6 > range[0] && at.getHours() % step === 0) {
      out.push([at.getTime() * 1e6, at.getHours() === 0 ? at.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })]);
    }
  }
  return out;
}
