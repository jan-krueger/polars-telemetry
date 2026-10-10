import { useMemo, useState } from "react";
import { span } from "../lib/format";
import { clock } from "../lib/time";
import { facets, groups, queries, type Filter, type GroupSummary, type QuerySummary } from "./api";
import { FacetList, useLoad, useSearch } from "./shared";
import { follow, go } from "./App";

type Sort = "name" | "runs" | "total" | "last";
const RANGES: [string, number | null][] = [["last 24 hours", 1], ["last 7 days", 7], ["last 30 days", 30], ["all time", null]];
const COLUMNS: [Sort, string, boolean][] = [["name", "Label", false], ["runs", "Runs", true], ["total", "Total", true], ["last", "Last run", true]];
const RULES_SHOWN = 2;
const PAGE = 10;

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
  const text = params.get("q") ?? "";
  const label = params.get("label");
  const sorted = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return sortGroups((found ?? []).filter((g) => !needle || (g.key ?? "").toLowerCase().includes(needle)), sort);
  }, [found, sort, text]);
  const now = Date.now();

  return (
    <div className="shell shell--queries">
      <aside className="rail">
        <FacetList counts={counts} params={params} update={update} />
      </aside>
      <main>
        <div className="nbar">
          <input id="label-search" className="nsearch" type="search" placeholder="Search labels" value={text}
                 aria-label="Search labels" onChange={(e) => update({ q: e.target.value || null }, true)} />
          <span className="grow" />
          <select id="range" value={days ?? ""} aria-label="Time range" onChange={(e) => update({ days: e.target.value === "30" ? null : e.target.value || "0" })}>
            {RANGES.map(([name, value]) => <option key={name} value={value ?? ""}>{name}</option>)}
          </select>
        </div>
        {found === null ? <div className="nsoon">Loading…</div>
          : !found.length ? <div className="nsoon">No queries in this range.</div>
          : (
          <div className="nsplit">
            <table className="ntable">
              <thead>
                <tr>
                  {COLUMNS.map(([column, name, numeric]) => (
                    <th key={column} className={numeric ? "num" : ""} aria-sort={sort === column ? (column === "name" ? "ascending" : "descending") : undefined}>
                      <button className="nsort" onClick={() => update({ sort: column === "total" ? null : column })}>{name}</button>
                    </th>
                  ))}
                  <th>Trend</th>
                  <th>Warnings</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((group) => (
                  <tr key={group.key ?? ""} aria-selected={group.key === label} onClick={() => update({ label: group.key === label ? null : group.key })}>
                    <td className="nlabel">{group.key ?? <span className="dim">no label</span>}</td>
                    <td className="num">{group.runs}</td>
                    <td className="num">{group.recent_wall_ms.length ? span(group.total_wall_ms) : "–"}</td>
                    <td className="num dim">{ago(group.last_started_unix_ns, now)}</td>
                    <td><Spark values={group.recent_wall_ms} /></td>
                    <td><Rules group={group} /></td>
                  </tr>
                ))}
                {!sorted.length && <tr className="nnone"><td colSpan={6}>No label matches “{text}”.</td></tr>}
              </tbody>
            </table>
            {label !== null && <LabelPanel label={label} key={label} now={now} />}
          </div>
        )}
      </main>
    </div>
  );
}

function sortGroups(list: GroupSummary[], sort: Sort): GroupSummary[] {
  const copy = [...list];
  if (sort === "name") copy.sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""));
  else if (sort === "runs") copy.sort((a, b) => b.runs - a.runs);
  else if (sort === "last") copy.sort((a, b) => b.last_started_unix_ns - a.last_started_unix_ns);
  else copy.sort((a, b) => b.total_wall_ms - a.total_wall_ms);
  return copy;
}

function ago(ns: number, now: number): string {
  const s = Math.max(0, (now - ns / 1e6) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

function Rules({ group }: { group: GroupSummary }) {
  return (
    <span className="nrules">
      {group.failed ? <span className="npill npill--failed">{group.failed} failed</span> : null}
      {group.rules.slice(0, RULES_SHOWN).map((rule) => <code key={rule} className="nrule">{rule}</code>)}
      {group.rules.length > RULES_SHOWN ? <span className="dim" title={group.rules.slice(RULES_SHOWN).join(", ")}>+{group.rules.length - RULES_SHOWN}</span> : null}
    </span>
  );
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="dim">–</span>;
  const w = 84, h = 20, max = Math.max(...values, 1e-9);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 1 - (v / max) * (h - 2)}`).join(" ");
  return <svg className="nspark" width={w} height={h} aria-hidden="true"><polyline points={points} /></svg>;
}

function LabelPanel({ label, now }: { label: string; now: number }) {
  const runs = useLoad(() => queries({ label, limit: 200 }), label);
  const [shown, setShown] = useState(PAGE);
  if (runs === null) return <aside className="npanel"><div className="dim">Loading {label}…</div></aside>;
  const oldestFirst = [...runs].reverse();
  const days = new Set(runs.map((run) => new Date(run.started_unix_ns / 1e6).toDateString())).size > 1;
  const when = (ns: number) => clock(ns, days);
  const current = runs[0]?.fingerprint ?? null;
  const changedAt = runs.findIndex((run) => run.fingerprint !== current);
  const latest = runs[0];
  return (
    <aside className="npanel">
      <div className="npanel-head">
        <div>
          <b>{label}</b>
          <div className="dim">{runs.length} runs · last {latest ? ago(latest.started_unix_ns, now) : "–"}</div>
        </div>
        {latest && <a className="nbutton" href={`/queries/${latest.query_id}`} onClick={follow}>Open latest run</a>}
      </div>
      <Trend runs={oldestFirst} changed={changedAt > 0 ? runs.length - changedAt : null} when={when} />
      <table className="ntable">
        <thead><tr><th>Run</th><th className="num">Took</th><th>Host</th></tr></thead>
        <tbody>
          {runs.slice(0, shown).map((run, i) => (
            <tr key={run.query_id} onClick={() => go(`/queries/${run.query_id}`)}>
              <td>
                <a href={`/queries/${run.query_id}`} onClick={follow}>{when(run.started_unix_ns)}</a>
                {changedAt > 0 && i === changedAt - 1 ? <span className="nchanged">plan changed</span> : null}
              </td>
              <td className="num">{run.status === "failed" ? <span className="npill npill--failed">failed</span> : run.wall_ms === null ? "–" : span(run.wall_ms)}</td>
              <td>{run.host}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.length > shown && <button className="link" onClick={() => setShown(shown + PAGE * 2)}>Show {Math.min(PAGE * 2, runs.length - shown)} more of {runs.length - shown}</button>}
    </aside>
  );
}

/** Each run's wall time; runs far above the rest sit on the top edge, so one outlier does not flatten the others. */
function Trend({ runs, changed, when }: { runs: QuerySummary[]; changed: number | null; when: (ns: number) => string }) {
  if (!runs.length) return null;
  const walls = runs.filter((run) => run.wall_ms !== null && run.status !== "failed").map((run) => run.wall_ms!).sort((a, b) => a - b);
  const typical = walls[Math.floor((walls.length - 1) * 0.9)] ?? 1;
  const max = Math.min(walls.at(-1) ?? 1, typical * 2) * 1.12 || 1;
  const w = 340, h = 140, top = 12;
  const x = (i: number) => 10 + (runs.length === 1 ? (w - 20) / 2 : (i / (runs.length - 1)) * (w - 20));
  const y = (v: number) => h - 20 - (Math.min(v, max) / max) * (h - 20 - top);
  const split = changed === null ? null : (x(changed - 1) + x(changed)) / 2;
  return (
    <svg className="ntrend" width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Wall time of each run">
      <text x={10} y={top - 2}>{span(max)}</text>
      {split !== null && (
        <>
          <line x1={split} x2={split} y1={top} y2={h - 20} className="nguide" />
          <text x={split + 4} y={top + 10}>plan changed</text>
        </>
      )}
      {runs.map((run, i) => run.status === "failed" || run.wall_ms === null
        ? <path key={run.query_id} d={`M${x(i) - 4},${h - 26} l8,8 m0,-8 l-8,8`} className="nfailed"><title>failed</title></path>
        : <circle key={run.query_id} cx={x(i)} cy={y(run.wall_ms)} r={3.6} className={run.wall_ms > max ? "nover" : changed !== null && i < changed ? "nbefore" : ""}
                  onClick={() => go(`/queries/${run.query_id}`)}>
            <title>{`${when(run.started_unix_ns)} · ${span(run.wall_ms)}`}</title>
          </circle>)}
      <text x={10} y={h - 5}>{when(runs[0]!.started_unix_ns)}</text>
      <text x={w - 10} y={h - 5} textAnchor="end">{when(runs[runs.length - 1]!.started_unix_ns)}</text>
    </svg>
  );
}
