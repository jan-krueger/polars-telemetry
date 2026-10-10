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
