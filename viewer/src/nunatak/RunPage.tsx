import { useEffect, useMemo, useReducer, useState } from "react";
import type { Profile } from "../model/profile";
import PickedNode from "../components/PickedNode";
import QueryView from "../components/QueryView";
import useMoment from "../hooks/useMoment";
import usePanes from "../hooks/usePanes";
import { span } from "../lib/format";
import { byNode } from "../lib/insights";
import { initialState, reducer } from "../state/viewer";
import { NotFound, query, queries, recording, usual, type QuerySummary } from "./api";
import { follow } from "./App";

type Loaded =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; message: string }
  | { state: "ready"; summary: QuerySummary; profile: Profile | null; typical: { usually: number; slow: number } | null };

function useRun(id: string): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let current = true;
    setLoaded({ state: "loading" });
    (async () => {
      const summary = await query(id);
      const [profile, siblings] = await Promise.all([
        summary.recording ? recording(id) : Promise.resolve(null),
        summary.label ? queries({ label: summary.label, limit: 200 }) : Promise.resolve([]),
      ]);
      return { state: "ready" as const, summary, profile, typical: usual(siblings, id) };
    })()
      .then((ready) => current && setLoaded(ready))
      .catch((error: unknown) => current && setLoaded(error instanceof NotFound ? { state: "missing" } : { state: "error", message: String(error) }));
    return () => {
      current = false;
    };
  }, [id]);
  return loaded;
}

export default function RunPage({ id }: { id: string }) {
  const loaded = useRun(id);
  if (loaded.state === "loading") return <div className="nsoon">Opening the query…</div>;
  if (loaded.state === "missing") return <div className="nsoon">No query with this id.</div>;
  if (loaded.state === "error") return <div className="nsoon">Could not load the query: {loaded.message}</div>;
  return <Run summary={loaded.summary} profile={loaded.profile} typical={loaded.typical} />;
}

function Run({ summary, profile, typical }: { summary: QuerySummary; profile: Profile | null; typical: { usually: number; slow: number } | null }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const panes = usePanes();
  const findings = useMemo(() => byNode(profile), [profile]);
  const { moment, physical } = useMoment(profile, state.replayAt);
  const where = [summary.service, summary.host, summary.environment].filter(Boolean).join(" · ");
  return (
    <div className="shell shell--run">
      <main>
        {profile ? (
          <QueryView profile={profile} moment={moment} findings={findings} panes={panes}
                     node={state.node} focus={state.focus} replayAt={state.replayAt} dispatch={dispatch}
                     withDates heading={<Heading summary={summary} />} extra={<Versus summary={summary} typical={typical} />}
                     share={{
                       link: () => ({ url: location.href, chars: 0 }),
                       linkNote: "Opens this run in Nunatak",
                       download: {
                         label: "Download recording",
                         note: "This run's events, for the viewer",
                         run: () => open(`/api/queries/${encodeURIComponent(summary.query_id)}/recording`),
                       },
                     }} />
        ) : (
          <>
            <div className="qline"><Heading summary={summary} /></div>
            <div className="nsoon">{summary.status === "running" ? "This query is still running; following it live comes next." : "No recording kept for this run."}</div>
          </>
        )}
      </main>
      <aside className="rail right">
        <PickedNode profile={profile} node={state.node} moment={moment} physical={physical} findings={findings} />
      </aside>
    </div>
  );
}

function Heading({ summary }: { summary: QuerySummary }) {
  const where = [summary.service, summary.host, summary.environment].filter(Boolean).join(" · ");
  return (
    <span className="nheading">
      <span className="crumb"><a href="/queries" onClick={follow}>Queries</a> / <b>{summary.label ?? summary.query_id}</b></span>
      <span className={`npill npill--${summary.status}`}>{summary.status}</span>
      <span className="dim">{where}</span>
    </span>
  );
}

function Versus({ summary, typical }: { summary: QuerySummary; typical: { usually: number; slow: number } | null }) {
  if (!typical) return <span className="nversus">· first run of this label</span>;
  const usually = typical.slow > typical.usually * 1.05
    ? `usually ${span(typical.usually)}, slow ${span(typical.slow)}`
    : `usually ${span(typical.usually)}`;
  const change = summary.wall_ms !== null && summary.status === "finished" ? (summary.wall_ms - typical.usually) / typical.usually : 0;
  return (
    <span className="nversus">
      ·{Math.abs(change) >= 0.1 ? <b className={change > 0 ? "nslower" : "nfaster"}> {change > 0 ? "+" : ""}{Math.round(change * 100)}%</b> : null} {usually}
    </span>
  );
}
