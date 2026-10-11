import { useState } from "react";
import { span } from "../lib/format";
import { overview, queries, recording, versions, type Filter, type QueryOverview, type QuerySummary, type Version } from "./api";
import { go } from "./App";
import { RunsChart, type Plan, type Range } from "./charts";
import { planDiff } from "./plans";
import { DAY_MS, Link, daysOf, filterOf, link, runPath, useLoad, useSearch } from "./shared";
import { kinds, reason, ruleName, times, when } from "./words";

const PAGE = 20;
const VERSIONS_SHOWN = 4;
const RUNS_PAGE = 1000;
const RUNS_MOST = 5000;

/** Every run of the filter, newest first, read a thousand at a time up to five thousand. */
async function allRuns(filter: Filter): Promise<QuerySummary[]> {
  const out: QuerySummary[] = [];
  while (out.length < RUNS_MOST) {
    const page = await queries({ ...filter, limit: RUNS_PAGE, offset: out.length });
    out.push(...page);
    if (page.length < RUNS_PAGE) break;
  }
  return out;
}

export default function LabelPage({ label }: { label: string }) {
  const [params, update] = useSearch();
  const filter = { ...filterOf(params), label };
  const days = daysOf(params);
  const key = `${JSON.stringify(filter)}${days}`;
  const data = useLoad(() => overview(filter, days), key);
  const since = data?.since_unix_ns;
  const runs = useLoad(() => (since ? allRuns({ ...filter, since }) : Promise.resolve(null)), `${key}${since}`);
  const selected = params.get("plan");
  const pick = (fingerprint: string | null) => {
    const value = fingerprint ?? "-";
    update({ plan: selected === value ? null : value }, true);
  };
  const plans = useLoad(() => versions(label, Math.round((Date.now() - Math.max(days, 30) * DAY_MS) * 1e6)), label);
  const q = data?.queries[0];
  if (data === null || runs === null || plans === null) return <main className="npage"><p className="nquiet">Loading {label}…</p></main>;
  const range: Range = [data.since_unix_ns, data.now_unix_ns];
  const named = name(plans, q?.verdict === "slower");
  const hosts = [...new Set(runs.map((r) => r.host))].sort();
  return (
    <main className="npage">
      <div className="ntitle">
        <span className="crumb"><Link to="/queries">Queries</Link> / <b>{label}</b></span>
        {q && <span className="dim">{[q.service, hosts.length > 3 ? `${hosts.length} hosts` : hosts.join(", ")].filter(Boolean).join(" · ")}</span>}
        <span className="grow" />
        {runs[0] && <Link to={runPath(runs[0].query_id)} className="nbutton">Open latest run</Link>}
      </div>
      {!q ? <p className="nquiet">This query did not run in this range with these filters.</p> : (
        <>
          <Verdict q={q} />
          <div className="npanel-box nchart">
            <RunsChart runs={runs} plans={named} range={range} selected={selected} onOpen={(id) => go(link(runPath(id)))} />
          </div>
          {plans.length > 0 && <Versions plans={plans} named={named} selected={selected} onPick={pick} />}
          <Runs key={selected ?? ""} runs={selected === null ? runs : runs.filter((r) => (r.fingerprint ?? "-") === selected)}
                named={named} plans={plans} selected={named.find((p) => (p.fingerprint ?? "-") === selected) ?? null} onClear={() => pick(null)} />
        </>
      )}
    </main>
  );
}

/** Plan 1, Plan 2… by when each first ran; the current one in the accent colour, or red when it got slower. */
function name(plans: Version[], slower: boolean): (Plan & Version)[] {
  const oldestFirst = [...plans].sort((a, b) => a.first_started_unix_ns - b.first_started_unix_ns);
  const current = plans[0]?.fingerprint;
  return oldestFirst.map((v, i) => ({
    ...v,
    name: `Plan ${i + 1}`,
    colour: v.fingerprint === current ? (slower ? "var(--crit)" : "var(--accent)") : i === oldestFirst.length - 2 ? "var(--muted)" : "var(--axis)",
  }));
}

function Verdict({ q }: { q: QueryOverview }) {
  const found = kinds(q);
  const shown = found.filter((k) => !(k === "warning" && found.includes("slower") && q.plan_changed_unix_ns !== null));
  if (!shown.length) return null;
  const tone = found.includes("slower") || found.includes("failing") ? "bad" : found.includes("warning") ? "warn" : "good";
  return <p className={`nverdict nverdict--${tone}`}>{shown.map((k) => reason(q, k)).join(" ")}</p>;
}

function Versions({ plans, named, selected, onPick }: { plans: Version[]; named: (Plan & Version)[]; selected: string | null; onPick: (fingerprint: string | null) => void }) {
  const newest = plans.slice(0, VERSIONS_SHOWN);
  return (
    <section className="nversions">
      {newest.map((v, i) => {
        const plan = named.find((p) => p.fingerprint === v.fingerprint)!;
        const before = plans[i + 1];
        const on = selected === (v.fingerprint ?? "-");
        return (
          <div key={v.fingerprint ?? ""} className={on ? "npanel-box nversion on" : "npanel-box nversion"} role="button" tabIndex={0} aria-pressed={on}
               onClick={() => onPick(v.fingerprint)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(v.fingerprint))}>
            <h4><i style={{ background: plan.colour }} />{plan.name}<span className="dim">· {i === 0 ? `since ${when(v.first_started_unix_ns)}` : `${when(v.first_started_unix_ns)} to ${when(v.last_started_unix_ns)}`}</span></h4>
            <div className="nversion-stats">
              <span><b>{v.runs.toLocaleString()}</b> runs</span>
              {v.usual_wall_ms !== null && <span>usually <b>{span(v.usual_wall_ms)}</b></span>}
              {v.failed > 0 && <span className="bad">{v.failed} failed</span>}
              {v.rules.length > 0 && <span>{v.rules.map((r) => <span key={r} className="nfind">{ruleName(r)}</span>)}</span>}
            </div>
            {before && <Diff id={v.latest_query_id} before={before.latest_query_id} name={named.find((p) => p.fingerprint === before.fingerprint)!.name} />}
          </div>
        );
      })}
    </section>
  );
}

function Diff({ id, before, name }: { id: string; before: string; name: string }) {
  const found = useLoad(async () => {
    const [a, b] = await Promise.all([recording(id), recording(before)]);
    return a && b ? planDiff(a.plan.physical, b.plan.physical) : null;
  }, `${id}${before}`);
  if (!found) return null;
  return (
    <div className="ndiff">
      {found.added.map((text, i) => <div key={`a${i}`} className="add">+ {text}</div>)}
      {found.dropped.map((text, i) => <div key={`d${i}`} className="drop">− {text}</div>)}
      <div className="dim">{!found.added.length && !found.dropped.length ? `same nodes as ${name}` : `${found.same} more as in ${name}`}</div>
    </div>
  );
}

function Runs({ runs, named, plans, selected, onClear }: { runs: QuerySummary[]; named: (Plan & Version)[]; plans: Version[]; selected: Plan | null; onClear: () => void }) {
  const [page, setPage] = useState(0);
  const usual = new Map(plans.map((v) => [v.fingerprint, v.usual_wall_ms]));
  const pages = Math.max(1, Math.ceil(runs.length / PAGE));
  const shown = runs.slice(page * PAGE, (page + 1) * PAGE);
  return (
    <section className="nstack-tight">
      <div className="nruns-head">
        <h3 className="nh">Runs</h3>
        {selected && <button className="nchip nchip--plan" onClick={onClear} aria-label={`Show runs of every plan, not only ${selected.name}`}><i style={{ background: selected.colour }} />{selected.name} ×</button>}
        <span className="grow" />
        {runs.length > PAGE && (
          <span className="npager">
            <span className="num">{page * PAGE + 1}–{Math.min(runs.length, (page + 1) * PAGE)} of {runs.length.toLocaleString()}</span>
            <button className="pane-btn" onClick={() => setPage(page - 1)} disabled={page === 0} aria-label="Newer runs">‹</button>
            <button className="pane-btn" onClick={() => setPage(page + 1)} disabled={page >= pages - 1} aria-label="Older runs">›</button>
          </span>
        )}
      </div>
      <table className="ntable">
        <thead><tr><th>Started</th><th>Host</th><th className="num">Took</th><th>vs its plan</th><th>Plan</th><th className="nwide">Warnings</th></tr></thead>
        <tbody>
          {shown.map((r) => {
            const plan = named.find((p) => p.fingerprint === r.fingerprint);
            const typical = usual.get(r.fingerprint) ?? null;
            const ratio = typical && r.wall_ms !== null ? r.wall_ms / typical : null;
            return (
              <tr key={r.query_id} onClick={() => go(link(runPath(r.query_id)))}>
                <td><Link to={runPath(r.query_id)}>{when(r.started_unix_ns)}</Link></td>
                <td>{r.host}</td>
                <td className="num">{r.status === "failed" ? <span className="npill2 npill2--fail">failed</span> : r.wall_ms === null ? "–" : span(r.wall_ms)}</td>
                <td>
                  {r.status === "failed" ? <span className="nerror" title={r.failed ?? ""}>{r.failed?.split("\n")[0]}</span>
                    : ratio === null ? <span className="dim">–</span>
                    : ratio >= 1.5 || ratio <= 1 / 1.5 ? <span className={`npill2 npill2--${ratio > 1 ? "slow" : "fast"}`}>{times(ratio)}</span>
                    : <span className="dim">as usual</span>}
                </td>
                <td>{plan && <><i className="ndot" style={{ background: plan.colour }} />{plan.name}</>}</td>
                <td className="nwide">{r.rules.map((rule) => <span key={rule} className="nfind">{ruleName(rule)}</span>)}</td>
              </tr>
            );
          })}
          {!shown.length && <tr className="nnone"><td colSpan={6}>No runs of this plan in the range.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
