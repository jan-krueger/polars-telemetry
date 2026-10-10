import { useEffect, useMemo, useState } from "react";
import { num, span } from "../lib/format";
import { clock } from "../lib/time";
import { facets, groups, queries, type Filter, type GroupSummary, type Pulse, type QuerySummary } from "./api";
import { follow, go } from "./App";
import { FacetList, useLoad, useSearch } from "./shared";

const RECENT = 12;

interface Live {
  connected: boolean;
  running: QuerySummary[];
  pulses: Map<string, { pulse: Pulse; at: number }>;
  finished: QuerySummary[];
}

function useLive(): Live {
  const [live, setLive] = useState<Live>({ connected: false, running: [], pulses: new Map(), finished: [] });
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
        return { ...before, running: others, pulses, finished: [row, ...before.finished.filter((q) => q.query_id !== row.query_id)] };
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

function useNow(every: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() * 1e6; };

export default function NowPage() {
  const [params, update] = useSearch();
  const filter: Filter = {
    service: params.get("service") ?? undefined,
    environment: params.get("environment") ?? undefined,
    host: params.get("host") ?? undefined,
    status: params.get("status") ?? undefined,
  };
  const today: Filter = { ...filter, since: Math.round(startOfToday()) };
  const live = useLive();
  const now = useNow(1000);
  const key = JSON.stringify(filter) + live.finished.length;
  const counts = useLoad(() => facets(today), key);
  const typical = useLoad(() => groups({}, "fingerprint"), String(live.finished.length));
  const recentLoaded = useLoad(() => queries({ ...filter, limit: RECENT * 2 }), key);
  const usual = useMemo(() => new Map((typical ?? []).map((g) => [g.key, g])), [typical]);

  const matches = (q: QuerySummary) => (["service", "environment", "host"] as const).every((f) => !filter[f] || q[f] === filter[f]);
  const running = live.running.filter(matches).filter(() => !filter.status || filter.status === "running");
  const recent = mergeRecent(live.finished.filter(matches), recentLoaded ?? []).filter((q) => q.status !== "running").slice(0, RECENT);
  const today_ = counts?.status ?? [];
  const finishedToday = today_.find((c) => c.value === "finished")?.runs ?? 0;
  const failedToday = today_.find((c) => c.value === "failed")?.runs ?? 0;
  const busyNow = running.reduce((sum, q) => sum + (live.pulses.get(q.query_id)?.pulse.threads.at(-1) ?? 0), 0);
  const empty = live.connected && !running.length && recentLoaded !== null && !recentLoaded.length && !filter.service && !filter.environment && !filter.host && !filter.status;

  return (
    <div className="shell shell--queries">
      <aside className="rail"><FacetList counts={counts} params={params} update={update} /></aside>
      <main>
        {empty ? <Waiting /> : (
          <>
            <div className="nstat">
              <span><b>{running.length}</b> running</span>
              <span><b>{finishedToday}</b> finished today</span>
              <span><b className={failedToday ? "nslower" : ""}>{failedToday}</b> failed today</span>
              <span>threads busy now <b>{num(busyNow, 1)}</b></span>
              {!live.connected && <span className="nslower">reconnecting…</span>}
            </div>
            <h3 className="nh">Running</h3>
            {running.length ? (
              <div className="ncards">
                {running.map((q) => <Card key={q.query_id} query={q} pulse={live.pulses.get(q.query_id)} usual={usual.get(q.fingerprint)} now={now} />)}
              </div>
            ) : <p className="dim">Nothing running right now.</p>}
            <h3 className="nh">Recently finished</h3>
            <div className="nrecent">
              {recent.map((q) => <Recent key={q.query_id} query={q} usual={usual.get(q.fingerprint)} />)}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function mergeRecent(live: QuerySummary[], loaded: QuerySummary[]): QuerySummary[] {
  const seen = new Set<string>();
  return [...live, ...loaded].filter((q) => !seen.has(q.query_id) && seen.add(q.query_id));
}

function Card({ query, pulse, usual, now }: { query: QuerySummary; pulse?: { pulse: Pulse; at: number }; usual?: GroupSummary; now: number }) {
  const where = [query.service, query.host, query.environment].filter(Boolean).join(" · ");
  const elapsed = pulse ? pulse.pulse.elapsed_ms + Math.max(0, now - pulse.at) : query.wall_ms ?? 0;
  return (
    <a className="ncard" href={`/queries/${query.query_id}`} onClick={follow}>
      <div className="ncard-top"><span className="nlabel">{query.label ?? query.query_id}</span><span className="npill npill--running">live</span></div>
      <span className="dim">{where}</span>
      <Bars values={pulse?.pulse.threads ?? []} />
      <Versus elapsed={elapsed} usual={usual} />
      <span className="dim">
        {pulse?.pulse.busiest ? <>Busiest now: <span className="ink">{pulse.pulse.busiest.kind}</span> · {num(pulse.pulse.busiest.threads, 1)} threads</> : "Waiting for the first sample"}
        {pulse && pulse.pulse.nodes ? <> · nodes done {pulse.pulse.done}/{pulse.pulse.nodes}</> : null}
      </span>
    </a>
  );
}

function Bars({ values }: { values: number[] }) {
  const w = 300, h = 44, shown = values.slice(-60), max = Math.max(...shown, 1e-9), bw = w / Math.max(shown.length, 12);
  return (
    <svg className="nbars" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Threads busy per sample">
      <rect width={w} height={h} rx={4} className="nbars-ground" />
      {shown.map((v, i) => <rect key={i} x={i * bw + 1} y={h - (v / max) * (h - 4)} width={bw - 2} height={(v / max) * (h - 4)} className="nbars-bar" />)}
    </svg>
  );
}

function Versus({ elapsed, usual }: { elapsed: number; usual?: GroupSummary }) {
  if (!usual?.usual_wall_ms) return <div className="nvs"><span className="nvs-track" /><span><b className="ink">{span(elapsed)}</b> <span className="dim">· first run of this plan</span></span></div>;
  const slow = usual.slow_wall_ms ?? usual.usual_wall_ms;
  const scale = slow * 1.15;
  const at = (ms: number) => `${Math.min(100, (ms / scale) * 100)}%`;
  return (
    <div className="nvs">
      <span className="nvs-track">
        <span className="nvs-fill" style={{ width: at(elapsed) }} />
        <span className="nvs-tick" style={{ left: at(usual.usual_wall_ms) }} />
        {slow > usual.usual_wall_ms * 1.05 ? <span className="nvs-tick nvs-tick--slow" style={{ left: at(slow) }} /> : null}
      </span>
      <span><b className={elapsed > slow ? "nslower" : "ink"}>{span(elapsed)}</b> <span className="dim">· usually {span(usual.usual_wall_ms)}{slow > usual.usual_wall_ms * 1.05 ? `, slow ${span(slow)}` : ""}</span></span>
    </div>
  );
}

function Recent({ query, usual }: { query: QuerySummary; usual?: GroupSummary }) {
  const change = query.status === "finished" && query.wall_ms !== null && usual?.usual_wall_ms ? (query.wall_ms - usual.usual_wall_ms) / usual.usual_wall_ms : null;
  return (
    <a className={`nentry${query.status === "failed" ? " nentry--failed" : ""}`} href={`/queries/${query.query_id}`} onClick={follow}>
      <span className="nentry-line">
        <span className="nlabel">{query.label ?? query.query_id}</span>
        {query.status === "failed" ? <span className="npill npill--failed">failed</span>
          : query.status === "unfinished" ? <span className="npill npill--unfinished">unfinished</span>
          : <span>{query.wall_ms === null ? "–" : span(query.wall_ms)}</span>}
        {change === null ? null : Math.abs(change) < 0.1 ? <span className="dim">usual</span>
          : <b className={change > 0 ? "nslower" : "nfaster"}>{change > 0 ? "+" : ""}{Math.round(change * 100)}%</b>}
        {query.warnings ? <span className="npill npill--warn">⚠ {query.warnings}</span> : null}
      </span>
      <small>{clock(query.started_unix_ns, false)} · {[query.service, query.host].filter(Boolean).join(" · ")}</small>
    </a>
  );
}

function Waiting() {
  return (
    <div className="nwaiting">
      <h2>Waiting for the first query</h2>
      <p className="dim">Add this to the Python process whose queries you want to follow. A query appears here once it has run for a second.</p>
      <pre className="ncode">{`import os
import polars_telemetry
from polars_telemetry.export import HttpEventExporter

polars_telemetry.install(exporter=HttpEventExporter(
    "${location.origin}", token=os.environ["NUNATAK_TOKEN"], service="my-service",
))`}</pre>
      <p className="dim">The token is printed when nunatak first starts, and kept in <code>token</code> in its data folder. Recordings from <code>FileEventExporter</code> can be added with <code>nunatak import FILE</code>.</p>
      <button className="link" onClick={() => go("/queries")}>Or look at queries recorded before</button>
    </div>
  );
}
