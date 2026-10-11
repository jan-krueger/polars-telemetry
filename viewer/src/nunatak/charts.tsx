import type { CSSProperties } from "react";
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
}

/** Every run's wall time on a log scale, coloured by its plan, failures on a lane at the top. */
export function RunsChart({ runs, plans, range, days, changed }: { runs: QuerySummary[]; plans: Plan[]; range: Range; days: number[]; changed: number | null }) {
  const failures = runs.some((r) => r.status === "failed");
  const W = 1400, H = 260, L = 60, R = 16, T = failures ? 32 : 14, B = 24;
  const walls = runs.filter((r) => r.status === "finished" && r.wall_ms !== null).map((r) => r.wall_ms!);
  if (!runs.length) return null;
  const lo = Math.max(1e-3, Math.min(...walls, Infinity) / 1.5), hi = Math.max(...walls, lo * 10) * 1.5;
  const x = (ns: number) => L + ((ns - range[0]) / (range[1] - range[0])) * (W - L - R);
  const y = (v: number) => T + 12 + (1 - Math.log(v / lo) / Math.log(hi / lo)) * (H - T - B - 12);
  const ticks = [1e-3, 1e-2, 0.1, 1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7].flatMap((d) => [d, d * 3]).filter((v) => v >= lo && v <= hi);
  const colour = (r: QuerySummary) => plans.find((p) => p.fingerprint === r.fingerprint)?.colour ?? "var(--muted)";
  const step = days.length > 14 ? Math.ceil(days.length / 10) : 1;
  const dayTicks = days.filter((_, i) => i > 0 && (days.length - 1 - i) % step === 0);
  return (
    <svg className="nruns" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Wall time of every run, on a log scale">
      {ticks.map((v) => (
        <g key={v}>
          <line className="nruns-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text x={L - 6} y={y(v) + 3.5} textAnchor="end">{span(v)}</text>
        </g>
      ))}
      {dayTicks.map((t) => <text key={t} x={x(t)} y={H - 6} textAnchor="middle">{new Date(t / 1e6).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</text>)}
      {failures && <text x={L} y={12}>failed</text>}
      {failures && <line className="nruns-grid" x1={L} x2={W - R} y1={T - 4} y2={T - 4} />}
      {changed !== null && changed >= range[0] && (
        <g>
          <line className="nruns-change" x1={x(changed)} x2={x(changed)} y1={Math.max(2, T - 12)} y2={H - B} />
          <text className="nruns-label" x={x(changed) + (x(changed) > W * 0.7 ? -6 : 6)} y={T + 8} textAnchor={x(changed) > W * 0.7 ? "end" : "start"}>plan changed · {when(changed)}</text>
        </g>
      )}
      {runs.map((r) => r.status === "failed"
        ? <path key={r.query_id} className="nruns-failed" d={`M${x(r.started_unix_ns) - 3},${T - 16} l6,6 m0,-6 l-6,6`}><title>{`${when(r.started_unix_ns)} · failed`}</title></path>
        : r.wall_ms === null ? null
        : <circle key={r.query_id} cx={x(r.started_unix_ns)} cy={y(r.wall_ms)} r={2.4} style={{ fill: colour(r) }}><title>{`${when(r.started_unix_ns)} · ${span(r.wall_ms)}`}</title></circle>)}
    </svg>
  );
}
