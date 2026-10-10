import { useEffect, useState } from "react";
import { num, span } from "../lib/format";
import { clock } from "../lib/time";
import { facets, queries, type Filter, type Pulse, type QuerySummary } from "./api";
import { follow, go } from "./App";
import { FacetList, useLoad, useSearch } from "./shared";

const RECENT = 12;
const FAILED_WITHIN_MS = 3_600_000;
const SEEN_KEY = "nunatak.failures-seen";
const FIELDS = ["service", "environment", "host"] as const;

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
  };
  const today: Filter = { ...filter, since: Math.round(startOfToday()) };
  const live = useLive();
  const now = useNow(1000);
  const key = JSON.stringify(filter) + live.finished.length;
  const counts = useLoad(() => facets(today), key);
  const recentLoaded = useLoad(() => queries({ ...filter, limit: RECENT * 5 }), key);
  const failedLoaded = useLoad(() => queries({ ...filter, status: "failed", since: Math.round((Date.now() - FAILED_WITHIN_MS) * 1e6), limit: 50 }), key);
  const [seen, setSeen] = useState(readSeen);

  const matches = (q: QuerySummary) => (["service", "environment", "host"] as const).every((f) => !filter[f] || q[f] === filter[f]);
  const running = live.running.filter(matches);
  const recent = collapse(mergeRecent(live.finished.filter(matches), recentLoaded ?? []).filter((q) => q.status !== "running")).slice(0, RECENT);
  const cutoff = Math.max(seen, (now - FAILED_WITHIN_MS) * 1e6);
  const failed = byLabel(mergeRecent(live.finished.filter(matches), failedLoaded ?? []).filter((q) => q.status === "failed" && q.started_unix_ns > cutoff));
  const dismiss = () => setSeen(writeSeen(now * 1e6));
  const empty = live.connected && !running.length && recentLoaded !== null && !recentLoaded.length && !filter.service && !filter.environment && !filter.host;

  return (
    <div className="shell shell--queries">
      <aside className="rail"><FacetList counts={counts} params={params} update={update} fields={FIELDS} /></aside>
      <main>
        {empty ? <Waiting /> : (
          <>
            {failed.length ? (
              <section className="nfailures" aria-label="Failed in the last hour">
                <div className="nfailures-head">
                  <h3 className="nh">Failed in the last hour</h3>
                  <button className="link" onClick={dismiss}>Dismiss</button>
                </div>
                <table className="ntable nrecent">
                  <tbody>{failed.map((runs) => <Recent key={runs[0]!.query_id} runs={runs} />)}</tbody>
                </table>
              </section>
            ) : null}
            {running.length ? (
              <>
                <h3 className="nh">Running</h3>
                <div className="ncards">
                  {running.map((q) => <Card key={q.query_id} query={q} pulse={live.pulses.get(q.query_id)} now={now} />)}
                </div>
              </>
            ) : <p className="nidle">{live.connected ? "Nothing running right now." : "Reconnecting…"}</p>}
            <h3 className="nh">Recently finished</h3>
            {recent.length ? (
              <table className="ntable nrecent">
                <tbody>
                  {recent.map((runs) => <Recent key={runs[0]!.query_id} runs={runs} />)}
                </tbody>
              </table>
            ) : <p className="dim">Nothing finished yet.</p>}
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

function byLabel(rows: QuerySummary[]): QuerySummary[][] {
  const groups = new Map<string, QuerySummary[]>();
  for (const query of rows) groups.set(query.label ?? query.query_id, [...(groups.get(query.label ?? query.query_id) ?? []), query]);
  return [...groups.values()];
}

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeSeen(ns: number): number {
  try {
    localStorage.setItem(SEEN_KEY, String(ns));
  } catch {
    return ns;
  }
  return ns;
}

function Card({ query, pulse, now }: { query: QuerySummary; pulse?: { pulse: Pulse; at: number }; now: number }) {
  const where = [query.service, query.host, query.environment].filter(Boolean).join(" · ");
  const elapsed = pulse ? pulse.pulse.elapsed_ms + Math.max(0, now - pulse.at) : query.wall_ms ?? 0;
  return (
    <a className="ncard" href={`/queries/${query.query_id}`} onClick={follow}>
      <div className="ncard-top"><span className="nlabel">{query.label ?? query.query_id}</span><span className="npill npill--running">live</span></div>
      <span className="dim">{where}</span>
      <Bars values={pulse?.pulse.threads ?? []} />
      <span><b>{span(elapsed)}</b> <span className="dim">so far</span></span>
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

function collapse(rows: QuerySummary[]): QuerySummary[][] {
  const out: QuerySummary[][] = [];
  const plain = (q: QuerySummary) => q.status === "finished" && !q.warnings;
  for (const query of rows) {
    const last = out.at(-1)?.[0];
    const same = last && plain(last) && plain(query) && (["fingerprint", "label", "service", "host"] as const).every((f) => last[f] === query[f]);
    if (same) out.at(-1)!.push(query);
    else out.push([query]);
  }
  return out;
}

function Recent({ runs }: { runs: QuerySummary[] }) {
  const query = runs[0]!;
  const walls = runs.map((q) => q.wall_ms).filter((w): w is number => w !== null);
  const low = Math.min(...walls), high = Math.max(...walls);
  return (
    <tr className={query.status === "failed" ? "nrecent--failed" : ""} onClick={() => go(`/queries/${query.query_id}`)}>
      <td className="dim">{clock(query.started_unix_ns, false)}</td>
      <td className="nrecent-what">
        <a className="nlabel" href={`/queries/${query.query_id}`} onClick={follow}>{query.label ?? query.query_id}</a>
        <span className="dim">{[query.service, query.host].filter(Boolean).join(" · ")}</span>
      </td>
      <td className="num dim">{runs.length > 1 ? `×${runs.length}` : ""}</td>
      <td className="num">
        {query.status === "failed" ? <span className="npill npill--failed">failed</span>
          : query.status === "unfinished" ? <span className="npill npill--unfinished">unfinished</span>
          : !walls.length ? "–" : low === high ? span(low) : `${span(low)}–${span(high)}`}
      </td>
      <td>
        {query.status === "failed" && query.failed ? <span className="nerror" title={query.failed}>{query.failed.split("\n")[0]}</span>
          : query.rules.map((rule) => <code key={rule} className="nrule">{rule}</code>)}
      </td>
    </tr>
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
