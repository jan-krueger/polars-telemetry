import type { Metrics, PlanNode, Replay, Series } from "../model/profile";
import { PEAKS } from "./counters";

export type NodeState = "waiting" | "running" | "done";

/** A query as it stood at one moment of its run. */
export interface Moment {
  t: number;
  metrics: Map<number, Metrics>;
  state: Map<number, NodeState>;
  /** Rows each node sends per second in the interval around `t`. */
  flow: Map<number, number>;
  cpu_ms: number;
}

const NOT_STARTED: Metrics = { total_time_ns: 0, rows_received: 0, rows_sent: 0, done: false };

const count = (metrics: Metrics | undefined, key: string): number => {
  const value = metrics?.[key];
  return typeof value === "number" ? value : 0;
};

/** The last index in `sorted` that is at most `value`, or -1. */
function atOrBefore(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= value) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The node's counters as of sample `index`, carried forward from when they last changed. */
function asOf(series: Series | undefined, index: number): Metrics | undefined {
  if (!series || index < 0) return undefined;
  const i = atOrBefore(series.at, index);
  return i < 0 ? undefined : series.metrics[i];
}

/** Counters only grow, so between two samples a straight line is the plainest guess. */
function between(a: Metrics | undefined, b: Metrics | undefined, f: number): Metrics {
  if (a === b || !b) return a ?? NOT_STARTED;
  const out: Metrics = { done: !!a?.done };
  for (const key of Object.keys(b)) {
    if (key === "done") continue;
    const from = count(a, key);
    out[key] = PEAKS.has(key) ? from : from + (count(b, key) - from) * f;
  }
  return out;
}

function stateOf(metrics: Metrics): NodeState {
  if (metrics.done) return "done";
  for (const key in metrics) if (key !== "done" && count(metrics, key) > 0) return "running";
  return "waiting";
}

/** `t` ms into the query: each node's counters, interpolated between the samples either side. */
export function momentAt(replay: Replay, t: number): Moment {
  const i = atOrBefore(replay.times, t);
  const j = i + 1 < replay.times.length ? i + 1 : -1;
  const from = i < 0 ? 0 : replay.times[i]!;
  const to = j < 0 ? from : replay.times[j]!;
  const f = j < 0 ? 0 : (t - from) / (to - from);
  const seconds = (to - from) / 1000;
  const moment: Moment = { t, metrics: new Map(), state: new Map(), flow: new Map(), cpu_ms: 0 };
  for (const [id, series] of replay.nodes) {
    const a = asOf(series, i);
    const b = j < 0 ? a : asOf(series, j);
    const metrics = between(a, b, f);
    const state = stateOf(metrics);
    moment.metrics.set(id, metrics);
    moment.state.set(id, state);
    if (state === "running" && seconds > 0) moment.flow.set(id, Math.max(0, count(b, "rows_sent") - count(a, "rows_sent")) / seconds);
    moment.cpu_ms += count(metrics, "total_time_ns") / 1e6;
  }
  return moment;
}

/** How one of a node's counters stood at each sample, from 0 at the start to its final value at `end`. */
export function history(replay: Replay, final: PlanNode, end: number, key: string): [number, number][] {
  const series = replay.nodes.get(final.id);
  const points: [number, number][] = [[0, 0]];
  replay.times.forEach((ms, i) => points.push([ms, count(asOf(series, i), key)]));
  if (end > points[points.length - 1]![0]) points.push([end, count(final.metrics ?? undefined, key)]);
  return points;
}

/** A plan node with the counters it had at `moment`. */
export const nodeAt = (node: PlanNode, moment: Moment): PlanNode =>
  ({ ...node, metrics: moment.metrics.get(node.id) ?? NOT_STARTED, custom: [] });

/** When each node first reported itself finished, in ms. */
export function finishes(replay: Replay): number[] {
  const times: number[] = [];
  for (const series of replay.nodes.values()) {
    const i = series.metrics.findIndex((m) => m.done);
    if (i >= 0) times.push(replay.times[series.at[i]!]!);
  }
  return times;
}

/** A stretch between two samples in which a node was running, and the threads' worth of CPU it used. */
export interface Stretch {
  from: number;
  to: number;
  load: number;
}

export interface Lane {
  id: number;
  stretches: Stretch[];
  cpu_ns: number;
}

/** Each node's running stretches over the whole run, the last one ending at `end`. */
export function lanes(replay: Replay, plan: PlanNode[], end: number): Lane[] {
  const bounds = [0, ...replay.times];
  if (end > bounds[bounds.length - 1]!) bounds.push(end);
  const out: Lane[] = [];
  for (const node of plan) {
    const series = replay.nodes.get(node.id);
    const final = node.metrics ?? undefined;
    const at = (k: number): Metrics | undefined =>
      k === 0 ? undefined : k <= replay.times.length ? asOf(series, k - 1) : final;
    const stretches: Stretch[] = [];
    for (let k = 1; k < bounds.length; k++) {
      const a = at(k - 1);
      const b = at(k);
      const ms = bounds[k]! - bounds[k - 1]!;
      if (a?.done || !b || ms <= 0 || stateOf(b) === "waiting") continue;
      const load = (count(b, "total_time_ns") - count(a, "total_time_ns")) / 1e6 / ms;
      stretches.push({ from: bounds[k - 1]!, to: bounds[k]!, load: Math.max(0, load) });
    }
    if (stretches.length) out.push({ id: node.id, stretches, cpu_ns: count(final, "total_time_ns") });
  }
  return out;
}

/** Every node's lane, with what the strips are drawn against. */
export interface Runs {
  lanes: Map<number, Lane>;
  end: number;
  peak: number;
  /** The whole query: all nodes' load added up, per stretch. */
  total: Stretch[];
}

export function runsOf(replay: Replay, plan: PlanNode[], end: number): Runs {
  const all = lanes(replay, plan, end);
  const total = new Map<number, Stretch>();
  for (const s of all.flatMap((l) => l.stretches)) {
    const sum = total.get(s.from) ?? { from: s.from, to: s.to, load: 0 };
    sum.load += s.load;
    total.set(s.from, sum);
  }
  return {
    lanes: new Map(all.map((l) => [l.id, l])),
    end,
    peak: peakOf(all.flatMap((l) => l.stretches)),
    total: [...total.values()].sort((a, b) => a.from - b.from),
  };
}

export const peakOf = (stretches: Stretch[]): number => Math.max(1e-9, ...stretches.map((s) => s.load));
