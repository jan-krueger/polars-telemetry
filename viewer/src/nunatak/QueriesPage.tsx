import { span } from "../lib/format";
import { overview, queries, type QueryOverview, type QuerySummary } from "./api";
import { go } from "./App";
import { Spark, cellStyle, type Range } from "./charts";
import { elapsed, useLive, useNow } from "./live";
import { Link, daysOf, filterOf, labelPath, link, runPath, useLoad, useSearch } from "./shared";
import { ago, byAttention, cadence, needsLook, ruleName, times, type Kind } from "./words";

const REFRESH_MS = 30_000;
type Only = Kind | "look";
type Sort = "name" | "last" | "total";
const CHIPS: [Only, string, (q: QueryOverview) => boolean][] = [
  ["look", "needs a look", needsLook],
  ["slower", "slower", (q) => q.verdict === "slower"],
  ["failing", "failing", (q) => q.recent_failed > 0],
  ["warning", "new warnings", (q) => q.new_rules.length > 0],
  ["faster", "faster", (q) => q.verdict === "faster"],
];
const SORTS: [Sort, string][] = [["name", "Query"], ["last", "Last run"], ["total", "Total"]];

export default function QueriesPage() {
  const [params, update] = useSearch();
  const filter = filterOf(params);
  const days = daysOf(params);
  const live = useLive();
  const now = useNow(1000);
  const data = useLoad(() => overview(filter, days), `${JSON.stringify(filter)}${days}${Math.floor(now / REFRESH_MS)}`);
  const anything = useLoad(() => queries({ limit: 1 }), "anything");
  const text = params.get("q") ?? "";
  const only = params.get("only") as Only | null;
  const sort = params.get("sort") as Sort | null;
  const byDay = params.get("view") === "days";
  const all = data?.queries ?? [];
  const needle = text.trim().toLowerCase();
  const keep = CHIPS.find(([key]) => key === only)?.[2] ?? (() => true);
  const rows = all.filter((q) => (!needle || (q.label ?? "").toLowerCase().includes(needle)) && keep(q)).sort(sorter(sort));
  const range: Range = data ? [data.days[0]!, data.now_unix_ns] : [0, 1];
  const usual = new Map(all.map((q) => [q.label, q.usual_wall_ms]));
  const matches = (q: QuerySummary) => (["service", "environment", "host"] as const).every((f) => !filter[f] || q[f] === filter[f])
    && (!needle || (q.label ?? "").toLowerCase().includes(needle));
  const running = only ? [] : live.running.filter(matches);

  if (anything?.length === 0) return <main className="npage"><p className="nquiet">No queries yet. <Link to="/" className="ninline">Home</Link> shows how to send them from Python.</p></main>;
  return (
    <main className="npage">
      <div className="nbar">
        <input id="query-search" className="nsearch" type="search" placeholder="Search queries" value={text}
               aria-label="Search queries" onChange={(e) => update({ q: e.target.value || null }, true)} />
        {CHIPS.map(([key, name, test]) => {
          const count = all.filter(test).length;
          if (!count && only !== key) return null;
          return (
            <button key={key} className={`nchip nchip--${key}`} aria-pressed={only === key} onClick={() => update({ only: only === key ? null : key })}>
              {name} <b>{count}</b>
            </button>
          );
        })}
        <span className="grow" />
        <div className="nseg" role="group" aria-label="View">
          <button aria-pressed={!byDay} onClick={() => update({ view: null })}>Table</button>
          <button aria-pressed={byDay} onClick={() => update({ view: "days" })}>Day by day</button>
        </div>
      </div>
      {data === null ? <p className="nquiet">Loading…</p>
        : !all.length ? <p className="nquiet">No queries ran in this range with these filters.</p>
        : byDay ? <Days rows={rows} days={data.days} />
        : (
          <table className="ntable nqueries">
            <thead>
              <tr>
                {SORTS.slice(0, 2).map(([key, name]) => <Head key={key} sort={sort} column={key} name={name} update={update} />)}
                <th className="num">Lately</th>
                <th>vs usual</th>
                <th className="nwide">{days === 1 ? "24 hours" : `${days} days`}</th>
                <th className="nwide">Failures</th>
                <th className="nwide">Warnings</th>
                <Head sort={sort} column="total" name="Total" update={update} numeric />
              </tr>
            </thead>
            <tbody>
              {running.map((q) => {
                const typical = usual.get(q.label) ?? null;
                const took = elapsed(q, live.pulses.get(q.query_id), now);
                const share = typical ? took / typical : null;
                return (
                  <tr key={q.query_id} className="npinned" onClick={() => go(link(runPath(q.query_id)))}>
                    <td><Link to={runPath(q.query_id)} className="nlabel">{q.label ?? "Query without a label"}</Link><span className="sub">{[q.service, q.host].filter(Boolean).join(" · ")}</span></td>
                    <td><span className="nlive">running</span></td>
                    <td className="num">{span(took)}{typical !== null && <span className="sub">usually {span(typical)}</span>}</td>
                    <td>{share === null ? null : share > 1.5 ? <span className="npill2 npill2--slow">{share.toFixed(share < 10 ? 1 : 0)}× slower</span> : <span className="dim">{Math.round(share * 100)}%</span>}</td>
                    <td colSpan={4} className="dim nwide">{live.pulses.get(q.query_id)?.pulse.busiest ? `busiest: ${live.pulses.get(q.query_id)!.pulse.busiest!.kind}` : ""}</td>
                  </tr>
                );
              })}
              {rows.map((q) => <Row key={q.label ?? ""} q={q} range={range} days={days} />)}
              {!rows.length && <tr className="nnone"><td colSpan={8}>{needle ? <>No query matches &ldquo;{text}&rdquo;.</> : "No query fits this filter."}</td></tr>}
            </tbody>
          </table>
        )}
    </main>
  );
}

function sorter(sort: Sort | null): (a: QueryOverview, b: QueryOverview) => number {
  if (sort === "name") return (a, b) => (a.label ?? "￿").localeCompare(b.label ?? "￿");
  if (sort === "last") return (a, b) => b.last_started_unix_ns - a.last_started_unix_ns;
  if (sort === "total") return (a, b) => b.total_wall_ms - a.total_wall_ms;
  return byAttention;
}

function Head({ sort, column, name, update, numeric = false }: { sort: Sort | null; column: Sort; name: string; update: (c: Record<string, string | null>) => void; numeric?: boolean }) {
  return (
    <th className={numeric ? "num" : ""} aria-sort={sort === column ? (column === "name" ? "ascending" : "descending") : undefined}>
      <button className="nsort" onClick={() => update({ sort: sort === column ? null : column })}>{name}</button>
    </th>
  );
}

function Row({ q, range, days }: { q: QueryOverview; range: Range; days: number }) {
  const open = () => q.label && go(link(labelPath(q.label)));
  return (
    <tr onClick={open} className={q.label ? "" : "nplain"}>
      <td>
        {q.label ? <Link to={labelPath(q.label)} className="nlabel">{q.label}</Link> : <span className="nlabel dim">Queries without a label</span>}
        <span className="sub">{[q.service, cadence(q.runs, days)].filter(Boolean).join(" · ")}</span>
      </td>
      <td className="dim">{ago(q.last_started_unix_ns)}</td>
      <td className="num">{q.recent_wall_ms === null ? "–" : span(q.recent_wall_ms)}{q.usual_wall_ms !== null && <span className="sub">usually {span(q.usual_wall_ms)}</span>}</td>
      <td>
        {q.verdict ? <span className={`npill2 npill2--${q.verdict === "slower" ? "slow" : "fast"}`}>{times(q.ratio!)}</span>
          : q.usual_wall_ms === null ? <span className="dim">–</span> : <span className="dim">as usual</span>}
      </td>
      <td className="nwide"><Spark q={q} range={range} scale /></td>
      <td className="nwide">{q.recent_failed ? <span className="npill2 npill2--fail">{q.recent_failed} of {q.recent_runs} failed</span> : <span className="dim">–</span>}</td>
      <td className="nwide">
        {q.rules.length ? q.rules.map((r) => <span key={r} className={q.new_rules.includes(r) ? "nfind new" : "nfind"}>{ruleName(r)}</span>) : <span className="dim">–</span>}
      </td>
      <td className="num">{span(q.total_wall_ms)}</td>
    </tr>
  );
}

function Days({ rows, days }: { rows: QueryOverview[]; days: number[] }) {
  const services = [...new Set(rows.map((q) => q.service))].sort((a, b) => (a ?? "￿").localeCompare(b ?? "￿"));
  const short = (ns: number) => new Date(ns / 1e6).getDate();
  return (
    <div className="npanel-box nheat" style={{ gridTemplateColumns: `minmax(140px,220px) repeat(${days.length}, minmax(0,1fr)) 140px` }}>
      <span />
      {days.map((d) => <span key={d} className="nheat-day">{short(d)}</span>)}
      <span className="nheat-day nheat-tail">usual · lately</span>
      {services.map((service) => (
        <Service key={service ?? ""} service={service} rows={rows.filter((q) => q.service === service)} days={days} />
      ))}
      <div className="nheat-legend">
        <span><i style={{ background: "color-mix(in oklab, var(--accent) 70%, var(--cell))" }} />faster</span>
        <span><i />as usual</span>
        <span><i style={{ background: "color-mix(in oklab, var(--crit) 45%, var(--cell))" }} />slower</span>
        <span><i style={{ background: "color-mix(in oklab, var(--crit) 88%, var(--cell))" }} />3× slower</span>
        <span><i className="dot" />failures</span>
        <span><i className="bar" />plan changed</span>
      </div>
    </div>
  );
}

function Service({ service, rows, days }: { service: string | null; rows: QueryOverview[]; days: number[] }) {
  return (
    <>
      <span className="nheat-service">{service ?? "no service"}</span>
      {rows.map((q) => (
        <div key={q.label ?? ""} className="nheat-row" onClick={() => q.label && go(link(labelPath(q.label)))}>
          <span className="nheat-label" title={q.label ?? ""}>{q.label ? q.label.replace(`${service ?? ""}/`, "") : "without a label"}</span>
          {q.days.map((day, i) => {
            const end = days[i + 1] ?? Infinity;
            const changed = q.plan_changed_unix_ns !== null && q.plan_changed_unix_ns >= days[i]! && q.plan_changed_unix_ns < end;
            const what = day.runs ? `${day.runs} runs${day.median_wall_ms === null ? "" : `, median ${span(day.median_wall_ms)}`}${day.failed ? `, ${day.failed} failed` : ""}` : "no runs";
            return (
              <span key={days[i]} className={`nheat-cell${day.failed ? " f" : ""}${changed ? " p" : ""}${day.runs ? "" : " none"}`}
                    style={cellStyle(day, q.usual_wall_ms)} title={`${q.label ?? "without a label"} · ${new Date(days[i]! / 1e6).toLocaleDateString()} · ${what}`} />
            );
          })}
          <span className="nheat-tail num">
            {q.usual_wall_ms === null ? "–" : span(q.usual_wall_ms)} · <b className={q.verdict ? `n${q.verdict}` : ""}>{q.recent_wall_ms === null ? "–" : span(q.recent_wall_ms)}</b>
          </span>
        </div>
      ))}
    </>
  );
}
