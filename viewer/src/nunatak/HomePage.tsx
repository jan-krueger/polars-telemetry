import { span } from "../lib/format";
import { overview, queries, type QueryOverview, type QuerySummary } from "./api";
import { Spark, type Range } from "./charts";
import { elapsed, useLive, useNow, type Live } from "./live";
import { Link, daysOf, filterOf, labelPath, runPath, useLoad, useSearch } from "./shared";
import { cadence, kinds, reason, type Kind } from "./words";

const REFRESH_MS = 30_000;
const TOP = 8;
const KIND_NAMES: Record<Kind, string> = { slower: "Slower", failing: "Failing", warning: "New warning", faster: "Faster" };

export default function HomePage() {
  const [params] = useSearch();
  const filter = filterOf(params);
  const days = daysOf(params);
  const live = useLive();
  const now = useNow(1000);
  const data = useLoad(() => overview(filter, days), `${JSON.stringify(filter)}${days}${Math.floor(now / REFRESH_MS)}`);
  const anything = useLoad(() => queries({ limit: 1 }), "anything");
  if (anything?.length === 0 && !live.running.length) return <main className="npage"><Waiting /></main>;
  const range: Range = data ? [data.days[0]!, data.now_unix_ns] : [0, 1];
  const all = data?.queries ?? [];
  const changed = all.filter((q) => kinds(q).length).sort((a, b) => order(a) - order(b) || b.total_wall_ms - a.total_wall_ms);
  const usual = new Map(all.map((q) => [q.label, q.usual_wall_ms]));
  const matches = (q: QuerySummary) => (["service", "environment", "host"] as const).every((f) => !filter[f] || q[f] === filter[f]);
  const running = live.running.filter(matches);
  return (
    <main className="npage">
      <div className="ncols">
        <div className="nstack">
          {running.length > 0 && <Running live={live} running={running} usual={usual} now={now} />}
          <section className="nstack-tight">
            <h3 className="nh">What changed <em>· the last 24 hours against the two weeks before</em></h3>
            <div className="npanel-box">
              {data === null ? <p className="nquiet">Loading…</p> : (
                <>
                  {changed.map((q) => <Change key={q.label ?? ""} q={q} range={range} days={data.days.length} now={now} />)}
                  <div className="ncalm">
                    {changed.length
                      ? <span><b>{all.length - changed.length} {all.length - changed.length === 1 ? "query" : "queries"}</b> ran as usual.</span>
                      : <span>Nothing changed: {all.length === 1 ? "the one query" : `all ${all.length} queries`} ran as usual.</span>}
                    <Link to="/queries" className="ninline">All queries →</Link>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
        {data && <Side all={all} days={days} />}
      </div>
    </main>
  );
}

const order = (q: QueryOverview) => ["slower", "failing", "warning", "faster"].indexOf(kinds(q)[0]!);

function Running({ live, running, usual, now }: { live: Live; running: QuerySummary[]; usual: Map<string | null, number | null>; now: number }) {
  return (
    <section className="nstack-tight">
      <h3 className="nh">Running now <em>· {running.length}</em></h3>
      <div className="npanel-box">
        {running.map((q) => {
          const pulse = live.pulses.get(q.query_id);
          const took = elapsed(q, pulse, now);
          const typical = usual.get(q.label) ?? null;
          const share = typical ? took / typical : null;
          const over = share !== null && share > 1.5;
          const busiest = pulse?.pulse.busiest?.kind;
          return (
            <Link key={q.query_id} to={runPath(q.query_id)} className="nrunning">
              <span className="nrunning-what">
                <b>{q.label ?? "Query without a label"}</b>
                <span className="dim">{[q.service, q.host, busiest && `busiest: ${busiest}`].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="nrunning-time">
                <span>
                  <b className={over ? "bad num" : "num"}>{span(took)}</b>
                  <span className="dim">
                    {share === null ? " so far, no usual time yet"
                      : over ? `, ${share.toFixed(share < 10 ? 1 : 0)}× its usual ${span(typical!)}`
                      : ` of usually ${span(typical!)}`}
                  </span>
                </span>
                {share !== null && <span className="nprog" aria-hidden="true"><i className={over ? "over" : ""} style={{ width: `${Math.min(1, share) * 100}%` }} /></span>}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function Change({ q, range, days, now }: { q: QueryOverview; range: Range; days: number; now: number }) {
  const all = kinds(q);
  const shown = all.filter((k) => !(k === "warning" && all.includes("slower") && q.plan_changed_unix_ns !== null));
  const title = <>{q.label ?? "Queries without a label"}<small>{[q.service, cadence(q.runs, days)].filter(Boolean).join(" · ")}</small></>;
  return (
    <div className="nchange">
      <span className="nkinds">{all.map((k) => <span key={k} className={`nkind nkind--${k}`}>{KIND_NAMES[k]}</span>)}</span>
      <div>
        <h4>{q.label ? <Link to={labelPath(q.label)}>{title}</Link> : title}</h4>
        <p>{shown.map((k) => reason(q, k, now)).join(" ")}</p>
        {all.includes("failing") && q.label && <LastError label={q.label} />}
      </div>
      <Spark q={q} range={range} width={220} height={40} />
    </div>
  );
}

function LastError({ label }: { label: string }) {
  const failed = useLoad(() => queries({ label, status: "failed", limit: 1 }), label);
  const message = failed?.[0]?.failed?.split("\n")[0];
  return message ? <code className="nerror" title={failed![0]!.failed!}>{message}</code> : null;
}

function Side({ all, days }: { all: QueryOverview[]; days: number }) {
  const spent = all.reduce((t, q) => t + q.total_wall_ms, 0);
  const top = [...all].sort((a, b) => b.total_wall_ms - a.total_wall_ms).slice(0, TOP).filter((q) => q.total_wall_ms > 0);
  const services = new Set(all.map((q) => q.service).filter(Boolean)).size;
  const period = days === 1 ? "the last 24 hours" : `the last ${days} days`;
  return (
    <aside className="nstack">
      <section className="nstack-tight">
        <h3 className="nh">In {period}</h3>
        <div className="npanel-box nfacts">
          <div><b>{all.reduce((t, q) => t + q.runs, 0).toLocaleString()}</b><span>runs</span></div>
          <div><b>{all.length}</b><span>{all.length === 1 ? "query" : "queries"}{services > 1 ? ` in ${services} services` : ""}</span></div>
          <div><b>{span(spent)}</b><span>spent in queries</span></div>
          <div><b>{all.reduce((t, q) => t + q.failed, 0).toLocaleString()}</b><span>failed runs</span></div>
        </div>
      </section>
      {top.length > 0 && (
        <section className="nstack-tight">
          <h3 className="nh">Where the time went</h3>
          <div className="npanel-box ncosts">
            {top.map((q) => (
              <div key={q.label ?? ""} className="ncost">
                {q.label ? <Link to={labelPath(q.label)} className="n">{q.label}</Link> : <span className="n dim">without a label</span>}
                <span className="v num">{span(q.total_wall_ms)}</span>
                <span className="track"><i style={{ width: `${(q.total_wall_ms / top[0]!.total_wall_ms) * 100}%` }} /></span>
              </div>
            ))}
            <span className="dim">{Math.round((top.reduce((t, q) => t + q.total_wall_ms, 0) / spent) * 100)}% of all query time is in {top.length === 1 ? "this one" : `these ${top.length}`}.</span>
          </div>
        </section>
      )}
    </aside>
  );
}

export function Waiting() {
  return (
    <div className="nwaiting">
      <h2>Waiting for the first query</h2>
      <p className="dim">Add this to the Python process whose queries you want to follow. A query appears here once it has run for a second.</p>
      <pre className="ncode">{`import polars_telemetry
from polars_telemetry.export import HttpEventExporter

polars_telemetry.install(exporter=HttpEventExporter(
    "${location.origin}",
    service="my-service",
))`}</pre>
      <p className="dim">Run it with <code>NUNATAK_TOKEN</code> set to the token Nunatak printed when it first started; it is kept in the file <code>token</code> in Nunatak&rsquo;s data folder. Recordings from <code>FileEventExporter</code> can be added with <code>nunatak import FILE</code>.</p>
    </div>
  );
}

