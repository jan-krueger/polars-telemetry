import { useEffect, useState } from "react";
import type { Pulse, QuerySummary } from "./api";

export interface Live {
  connected: boolean;
  running: QuerySummary[];
  pulses: Map<string, { pulse: Pulse; at: number }>;
  finished: number;
}

/** The running queries and their latest samples, kept current over server-sent events. */
export function useLive(): Live {
  const [live, setLive] = useState<Live>({ connected: false, running: [], pulses: new Map(), finished: 0 });
  useEffect(() => {
    const source = new EventSource("/api/live");
    source.addEventListener("snapshot", (e) => {
      const { running, pulses } = JSON.parse((e as MessageEvent).data) as { running: QuerySummary[]; pulses: Pulse[] };
      const at = Date.now();
      setLive((before) => ({ ...before, connected: true, running, pulses: new Map(pulses.map((p) => [p.query_id, { pulse: p, at }])) }));
    });
    source.addEventListener("query", (e) => {
      const row = JSON.parse((e as MessageEvent).data) as QuerySummary;
      setLive((before) => {
        const others = before.running.filter((q) => q.query_id !== row.query_id);
        if (row.status === "running") return { ...before, running: [row, ...others] };
        const pulses = new Map(before.pulses);
        pulses.delete(row.query_id);
        return { ...before, running: others, pulses, finished: before.finished + 1 };
      });
    });
    source.addEventListener("pulse", (e) => {
      const pulse = JSON.parse((e as MessageEvent).data) as Pulse;
      setLive((before) => ({ ...before, pulses: new Map(before.pulses).set(pulse.query_id, { pulse, at: Date.now() }) }));
    });
    source.onerror = () => setLive((before) => ({ ...before, connected: false }));
    return () => source.close();
  }, []);
  return live;
}

export function useNow(every: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

/** How long a running query has run, from its latest sample, else from its start. */
export function elapsed(query: QuerySummary, pulse: { pulse: Pulse; at: number } | undefined, now: number): number {
  if (pulse) return pulse.pulse.elapsed_ms + Math.max(0, now - pulse.at);
  return Math.max(0, now - query.started_unix_ns / 1e6);
}
