import { useMemo } from "react";
import { span } from "../lib/format";
import { clock } from "../lib/time";
import { facets, groups, queries, type Filter, type GroupSummary, type QuerySummary } from "./api";
import { FacetList, useLoad, useSearch } from "./shared";
import { follow, go } from "./App";

type Sort = "total" | "name" | "last";
const RANGES: [string, number | null][] = [["last 24 hours", 1], ["last 7 days", 7], ["last 30 days", 30], ["all time", null]];
const SHAPE_COLORS = ["var(--accent)", "var(--shape-2)", "var(--shape-3)", "var(--shape-4)"];



export default function QueriesPage() {
  const [params, update] = useSearch();
  const days = params.has("days") ? Number(params.get("days")) || null : 30;
  const filter: Filter = {
    service: params.get("service") ?? undefined,
    environment: params.get("environment") ?? undefined,
    host: params.get("host") ?? undefined,
    status: params.get("status") ?? undefined,
    since: days ? Math.round((Date.now() - days * 86_400_000) * 1e6) : undefined,
  };
  const key = JSON.stringify(filter);
  const found = useLoad(() => groups(filter), key);
  const counts = useLoad(() => facets(filter), key);
  const sort = (params.get("sort") as Sort | null) ?? "total";
  const label = params.get("label");
  const sorted = useMemo(() => sortGroups(found ?? [], sort), [found, sort]);

  return (
    <div className="shell shell--queries">
      <aside className="rail">
        <FacetList counts={counts} params={params} update={update} />
      </aside>
      <main>
        <div className="nbar">
          <span className="seg">
            {(["total", "name", "last"] as Sort[]).map((option) => (
              <button key={option} aria-pressed={sort === option} onClick={() => update({ sort: option === "total" ? null : option })}>
                {{ total: "Total time", name: "Name", last: "Last run" }[option]}
              </button>
            ))}
          </span>
          <span className="grow" />
          <select value={days ?? ""} onChange={(e) => update({ days: e.target.value === "30" ? null : e.target.value || "0" })}>
            {RANGES.map(([name, value]) => <option key={name} value={value ?? ""}>{name}</option>)}
          </select>
        </div>
        {found === null ? <div className="nsoon">Loading…</div> : !sorted.length ? <div className="nsoon">No queries in this range.</div> : (
          <div className="nsplit">
            <table className="ntable">
              <thead><tr><th>Label</th><th className="num">Runs</th><th className="num">Usually</th><th className="num">Slow</th><th className="num">Total</th><th>Trend</th><th className="num">Shapes</th><th /></tr></thead>
              <tbody>
                {sorted.map((group) => (
                  <tr key={group.key ?? ""} aria-selected={group.key === label} onClick={() => update({ label: group.key === label ? null : group.key })}>
                    <td className="nlabel">{group.key ?? <span className="dim">no label</span>}</td>
                    <td className="num">{group.runs}</td>
                    <td className="num">{group.usual_wall_ms === null ? "–" : span(group.usual_wall_ms)}</td>
                    <td className="num">{group.slow_wall_ms === null ? "–" : span(group.slow_wall_ms)}</td>
                    <td className="num">{group.usual_wall_ms === null ? "–" : span(group.total_wall_ms)}</td>
                    <td><Spark values={group.recent_wall_ms} /></td>
                    <td className={group.shapes > 1 ? "num" : "num dim"}>{group.shapes}</td>
                    <td>
                      {group.failed ? <span className="npill npill--failed">{group.failed} failed</span> : null}
                      {group.warnings ? <span className="npill npill--warn">⚠ {group.warnings}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {label !== null && <LabelPanel label={label} key={label} />}
          </div>
        )}
      </main>
    </div>
  );
}

function sortGroups(list: GroupSummary[], sort: Sort): GroupSummary[] {
  const copy = [...list];
  if (sort === "name") copy.sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""));
  else if (sort === "last") copy.sort((a, b) => b.last_started_unix_ns - a.last_started_unix_ns);
  else copy.sort((a, b) => b.total_wall_ms - a.total_wall_ms);
  return copy;
}


function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="dim">–</span>;
  const w = 84, h = 20, max = Math.max(...values), min = Math.min(...values);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / (max - min || 1)) * (h - 4)}`).join(" ");
  return <svg className="nspark" width={w} height={h} aria-hidden="true"><polyline points={points} /></svg>;
}

function LabelPanel({ label }: { label: string }) {
  const runs = useLoad(() => queries({ label, limit: 200 }), label);
  if (runs === null) return <aside className="npanel"><div className="dim">Loading {label}…</div></aside>;
  const oldestFirst = [...runs].reverse();
  const shapes = [...new Set(oldestFirst.map((run) => run.fingerprint ?? "unknown"))];
  const color = (run: QuerySummary) => SHAPE_COLORS[shapes.indexOf(run.fingerprint ?? "unknown") % SHAPE_COLORS.length];
  const days = new Set(runs.map((run) => new Date(run.started_unix_ns / 1e6).toDateString())).size > 1;
  const when = (ns: number) => clock(ns, days);
  const firstSeen = (shape: string) => oldestFirst.find((run) => (run.fingerprint ?? "unknown") === shape)!.started_unix_ns;
  return (
    <aside className="npanel">
      <div className="npanel-head"><b>{label}</b><span className="dim">{runs.length} runs</span></div>
      {shapes.length > 1 && (
        <div className="nlegend">
          {shapes.map((shape, i) => (
            <span key={shape}><i style={{ background: SHAPE_COLORS[i % SHAPE_COLORS.length] }} />shape <code>{shape.slice(0, 8)}</code>{i ? ` since ${when(firstSeen(shape))}` : ""}</span>
          ))}
        </div>
      )}
      <Trend runs={oldestFirst} color={color} when={when} />
      <Change runs={oldestFirst} shapes={shapes} />
      <table className="ntable">
        <thead><tr><th>Run</th><th className="num">Took</th><th>Host</th>{shapes.length > 1 ? <th>Shape</th> : null}</tr></thead>
        <tbody>
          {runs.slice(0, 8).map((run) => (
            <tr key={run.query_id} onClick={() => go(`/queries/${run.query_id}`)}>
              <td><a href={`/queries/${run.query_id}`} onClick={follow}>{when(run.started_unix_ns)}</a></td>
              <td className="num">{run.status === "failed" ? <span className="npill npill--failed">failed</span> : run.wall_ms === null ? "–" : span(run.wall_ms)}</td>
              <td>{run.host}</td>
              {shapes.length > 1 ? <td><i className="ndot" style={{ background: color(run) }} /></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {runs.length > 8 && <div className="dim">{runs.length - 8} earlier runs</div>}
    </aside>
  );
}

function Trend({ runs, color, when }: { runs: QuerySummary[]; color: (run: QuerySummary) => string | undefined; when: (ns: number) => string }) {
  const finished = runs.filter((run) => run.wall_ms !== null && run.status !== "failed").map((run) => run.wall_ms!);
  if (!runs.length) return null;
  const w = 340, h = 140, max = Math.max(...finished, 1) * 1.12;
  const x = (i: number) => 10 + (runs.length === 1 ? (w - 20) / 2 : (i / (runs.length - 1)) * (w - 20));
  const y = (v: number) => h - 20 - (v / max) * (h - 34);
  const sorted = [...finished].sort((a, b) => a - b);
  const usually = sorted[Math.floor((sorted.length - 1) / 2)];
  return (
    <svg className="ntrend" width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Wall time of each run">
      {usually !== undefined && (
        <>
          <line x1={10} x2={w - 10} y1={y(usually)} y2={y(usually)} className="nguide" />
          <text x={w - 10} y={y(usually) - 4} textAnchor="end">usually {span(usually)}</text>
        </>
      )}
      {runs.map((run, i) => run.status === "failed" || run.wall_ms === null
        ? <path key={run.query_id} d={`M${x(i) - 4},${h - 26} l8,8 m0,-8 l-8,8`} className="nfailed"><title>failed</title></path>
        : <circle key={run.query_id} cx={x(i)} cy={y(run.wall_ms)} r={3.6} fill={color(run)} onClick={() => go(`/queries/${run.query_id}`)}>
            <title>{`${when(run.started_unix_ns)} · ${span(run.wall_ms)}`}</title>
          </circle>)}
      <text x={10} y={h - 5}>{when(runs[0]!.started_unix_ns)}</text>
      <text x={w - 10} y={h - 5} textAnchor="end">{when(runs[runs.length - 1]!.started_unix_ns)}</text>
    </svg>
  );
}

function Change({ runs, shapes }: { runs: QuerySummary[]; shapes: string[] }) {
  if (shapes.length < 2) return null;
  const newest = shapes[shapes.length - 1];
  const median = (list: QuerySummary[]) => {
    const walls = list.filter((run) => run.status === "finished" && run.wall_ms !== null).map((run) => run.wall_ms!).sort((a, b) => a - b);
    return walls.length ? walls[Math.floor((walls.length - 1) / 2)]! : null;
  };
  const after = median(runs.filter((run) => (run.fingerprint ?? "unknown") === newest));
  const before = median(runs.filter((run) => (run.fingerprint ?? "unknown") !== newest));
  if (after === null || before === null) return null;
  const change = (after - before) / before;
  if (Math.abs(change) < 0.1) return <p className="nchange">The newest plan shape runs about as fast as before.</p>;
  return <p className="nchange">Since the newest plan shape, runs take <b className={change > 0 ? "nslower" : "nfaster"}>{change > 0 ? "+" : ""}{Math.round(change * 100)}%</b> {change > 0 ? "longer" : "less"}.</p>;
}
