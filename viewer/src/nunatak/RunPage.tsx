import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Profile } from "../model/profile";
import PickedNode from "../components/PickedNode";
import QueryView from "../components/QueryView";
import useMoment from "../hooks/useMoment";
import usePanes from "../hooks/usePanes";
import { span } from "../lib/format";
import { byNode } from "../lib/insights";
import { initialState, reducer } from "../state/viewer";
import { EventLog, isEvent } from "../model/events";
import { readProfile } from "../model/read";
import { replayEnd } from "../lib/replay";
import { NotFound, queries, query, recording, versions, type QuerySummary, type Version } from "./api";
import { Link, labelPath, runPath, useLoad } from "./shared";
import { times, when } from "./words";

type Loaded =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; message: string }
  | { state: "ready"; summary: QuerySummary; profile: Profile | null };

function useRun(id: string, version: number): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let current = true;
    if (version === 0) setLoaded({ state: "loading" });
    (async () => {
      const summary = await query(id);
      const profile = summary.recording ? await recording(id) : null;
      return { state: "ready" as const, summary, profile };
    })()
      .then((ready) => current && setLoaded(ready))
      .catch((error: unknown) => current && setLoaded(error instanceof NotFound ? { state: "missing" } : { state: "error", message: String(error) }));
    return () => {
      current = false;
    };
  }, [id, version]);
  return loaded;
}

function useLiveProfile(id: string, following: boolean, onFinished: () => void): Profile | null {
  const [profile, setProfile] = useState<Profile | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => {
    if (!following) return;
    const log = new EventLog();
    const source = new EventSource(`/api/live/${encodeURIComponent(id)}`);
    source.addEventListener("events", (message) => {
      for (const line of (message as MessageEvent<string>).data.split("\n")) {
        try {
          const event: unknown = JSON.parse(line);
          if (isEvent(event)) log.apply(event);
        } catch {
          continue;
        }
      }
      const document = log.document(id);
      const read = document && readProfile(document);
      if (read && "profile" in read) setProfile(read.profile);
    });
    source.addEventListener("finished", () => {
      source.close();
      finished.current();
    });
    return () => source.close();
  }, [id, following]);
  return profile;
}

export default function RunPage({ id }: { id: string }) {
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const loaded = useRun(id, version);
  if (loaded.state === "loading") return <div className="nsoon">Opening the query…</div>;
  if (loaded.state === "missing") return <div className="nsoon">No query with this id.</div>;
  if (loaded.state === "error") return <div className="nsoon">Could not load the query: {loaded.message}</div>;
  return <Run summary={loaded.summary} recorded={loaded.profile} onFinished={reload} />;
}

interface RunProps {
  summary: QuerySummary;
  recorded: Profile | null;
  onFinished: () => void;
}

function Run({ summary, recorded, onFinished }: RunProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const plans = useLoad(() => (summary.label ? versions(summary.label) : Promise.resolve([])), summary.label ?? "");
  const named = plans ? [...plans].sort((a, b) => a.first_started_unix_ns - b.first_started_unix_ns) : [];
  const mine = named.findIndex((v) => v.fingerprint === summary.fingerprint);
  const panes = usePanes();
  const live = summary.status === "running";
  const following = useLiveProfile(summary.query_id, live, onFinished);
  const profile = recorded ?? following;
  const findings = useMemo(() => byNode(profile), [profile]);
  const head = live && profile?.replay ? replayEnd(profile) : null;
  const { moment, physical } = useMoment(profile, state.replayAt ?? head);
  return (
    <div className="shell shell--run">
      <main>
        {profile ? (
          <QueryView profile={profile} moment={moment} findings={findings} panes={panes}
                     node={state.node} focus={state.focus} replayAt={state.replayAt} dispatch={dispatch}
                     withDates live={live} heading={<Heading summary={summary} />}
                     extra={live ? null : <Against summary={summary} plans={named} mine={mine} />}
                     cutOff={summary.status === "finished" || summary.status === "failed"
                       ? "The recording is cut off; it shows the query up to its last readable event." : undefined}
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
            <div className="nsoon">{live ? "Waiting for the query's first sample…"
              : summary.recording ? "This run's recording is missing from Nunatak's data folder."
              : "No recording kept for this run."}</div>
          </>
        )}
      </main>
      <aside className="rail right">
        {profile && <PickedNode profile={profile} node={state.node} moment={moment} physical={physical} findings={findings}
                    onPick={(id) => dispatch({ type: "nodePicked", node: { plan: "physical", id } })} />}
      </aside>
    </div>
  );
}

function Heading({ summary }: { summary: QuerySummary }) {
  const where = [summary.service, summary.host, summary.environment].filter(Boolean).join(" · ");
  const label = summary.label;
  const earlier = useLoad(() => (label ? queries({ label, until: summary.started_unix_ns - 1, limit: 1 }) : Promise.resolve([])), summary.query_id);
  const later = useLoad(() => (label ? queries({ label, since: summary.started_unix_ns + 1, limit: 1, order: "oldest" }) : Promise.resolve([])), summary.query_id);
  return (
    <span className="nheading">
      <span className="crumb">
        <Link to="/queries">Queries</Link> / {label ? <><Link to={labelPath(label)}>{label}</Link> / </> : null}<b>{when(summary.started_unix_ns)}</b>
      </span>
      {label && (
        <span className="nstepper">
          {earlier?.[0] ? <Link to={runPath(earlier[0].query_id)}>‹ earlier</Link> : <span>‹ earlier</span>}
          {later?.[0] ? <Link to={runPath(later[0].query_id)}>later ›</Link> : <span>later ›</span>}
        </span>
      )}
      <span className={`npill npill--${summary.status}`}>{summary.status}</span>
      <span className="dim">{where}</span>
    </span>
  );
}

/** This run against the usual time of its plan, and of the plan before. */
function Against({ summary, plans, mine }: { summary: QuerySummary; plans: Version[]; mine: number }) {
  const plan = plans[mine];
  if (!plan || summary.wall_ms === null || summary.status !== "finished") return null;
  const ratio = plan.usual_wall_ms ? summary.wall_ms / plan.usual_wall_ms : null;
  const before = mine > 0 ? plans[mine - 1] : null;
  return (
    <>
      {plan.usual_wall_ms !== null && (
        <span className="nagainst">
          · usually {span(plan.usual_wall_ms)}
          {ratio !== null && (ratio >= 1.5 || ratio <= 1 / 1.5) ? <b className={ratio > 1 ? "bad" : "good"}> ({times(ratio)})</b> : null}
        </span>
      )}
      {before?.usual_wall_ms != null && <span className="nagainst">· Plan {mine}: {span(before.usual_wall_ms)}</span>}
    </>
  );
}
