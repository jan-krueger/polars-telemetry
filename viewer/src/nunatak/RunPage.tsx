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
import { NotFound, query, queries, recording, usual, type QuerySummary } from "./api";
import { follow } from "./App";

type Loaded =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; message: string }
  | { state: "ready"; summary: QuerySummary; profile: Profile | null; typical: { usually: number; slow: number } | null };

function useRun(id: string, version: number): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let current = true;
    if (version === 0) setLoaded({ state: "loading" });
    (async () => {
      const summary = await query(id);
      const [profile, siblings] = await Promise.all([
        summary.recording ? recording(id) : Promise.resolve(null),
        summary.label ? queries({ label: summary.label, fingerprint: summary.fingerprint ?? undefined, limit: 200 }) : Promise.resolve([]),
      ]);
      return { state: "ready" as const, summary, profile, typical: usual(siblings, id) };
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
  return <Run summary={loaded.summary} recorded={loaded.profile} typical={loaded.typical} onFinished={reload} />;
}

interface RunProps {
  summary: QuerySummary;
  recorded: Profile | null;
  typical: { usually: number; slow: number } | null;
  onFinished: () => void;
}

function Run({ summary, recorded, typical, onFinished }: RunProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const panes = usePanes();
  const live = summary.status === "running";
  const following = useLiveProfile(summary.query_id, live, onFinished);
  const profile = recorded ?? following;
  const findings = useMemo(() => byNode(profile), [profile]);
  const head = live && profile?.replay ? replayEnd(profile) : null;
  const { moment, physical } = useMoment(profile, state.replayAt ?? head);
  const where = [summary.service, summary.host, summary.environment].filter(Boolean).join(" · ");
  return (
    <div className="shell shell--run">
      <main>
        {profile ? (
          <QueryView profile={profile} moment={moment} findings={findings} panes={panes}
                     node={state.node} focus={state.focus} replayAt={state.replayAt} dispatch={dispatch}
                     withDates live={live} heading={<Heading summary={summary} />}
                     extra={<Versus summary={summary} typical={typical} elapsed={live ? profile.wall_ms : null} />}
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
            <div className="nsoon">{live ? "Waiting for the query's first sample…" : "No recording kept for this run."}</div>
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

function Versus({ summary, typical, elapsed }: { summary: QuerySummary; typical: { usually: number; slow: number } | null; elapsed: number | null }) {
  if (!typical) return <span className="nversus">· first run of this plan</span>;
  if (elapsed !== null) {
    const over = (elapsed - typical.usually) / typical.usually;
    return (
      <span className="nversus">
        ·{over >= 0.1 ? <b className="nslower"> +{Math.round(over * 100)}% so far</b> : null} usually {span(typical.usually)}
      </span>
    );
  }
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
