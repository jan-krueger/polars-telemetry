import { useEffect, useRef, type Dispatch } from "react";
import type { Profile, Session } from "../model/profile";
import { span } from "../lib/format";
import { title, type Action, type ShapeRow } from "../state/viewer";
import { SessionSwitcher } from "./Sessions";

interface Props {
  sessions: Session[];
  current: Session | null;
  shapes: ShapeRow[];
  prefix: string;
  search: string;
  queryId: string | null;
  dispatch: Dispatch<Action>;
  onKeep: (session: Session) => void;
}

const Breakable = ({ text }: { text: string }) =>
  text.split(/(?<=[/._])/).map((part, i) => <span key={i}>{i ? <wbr /> : null}{part}</span>);

const INNER_SHOWN = 5;

interface RunProps {
  profile: Profile;
  prefix: string;
  queryId: string | null;
  dispatch: Dispatch<Action>;
  extra?: string;
}

function Run({ profile: p, prefix, queryId, dispatch, extra = "" }: RunProps) {
  return (
    <button className="run" aria-pressed={p.query_id === queryId}
            onClick={() => dispatch({ type: "queryPicked", queryId: p.query_id })}>
      <div className="l1"><Breakable text={title(p).slice(prefix.length)} /></div>
      <div className="l2">{span(p.wall_ms)} wall{p.cpu_ms > 0 ? ` · ${span(p.cpu_ms)} cpu` : ""}{extra}</div>
    </button>
  );
}

function Inner({ runs, ...rest }: Omit<RunProps, "profile" | "extra"> & { runs: Profile[] }) {
  const list = runs.map((p) => <Run key={p.query_id} profile={p} {...rest} />);
  if (runs.length <= INNER_SHOWN) return <div className="inner">{list}</div>;
  const picked = runs.some((p) => p.query_id === rest.queryId);
  return (
    <details className="inner" open={picked || undefined}>
      <summary>{runs.length} queries inside</summary>
      {list}
    </details>
  );
}

export default function Sidebar({ sessions, current, shapes, prefix, search, queryId, dispatch, onKeep }: Props) {
  const list = useRef<HTMLElement>(null);

  useEffect(() => {
    const run = list.current?.querySelector('.run[aria-pressed="true"]');
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    run?.closest(".shape")?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [queryId]);

  return (
    <aside className="rail" ref={list}>
      {sessions.length > 0 && (
        <SessionSwitcher sessions={sessions} current={current} onKeep={onKeep}
                         onPick={(sessionId) => dispatch({ type: "sessionPicked", sessionId })}
                         onBrowse={() => dispatch({ type: "browsed", open: true })} />
      )}
      {current?.profiles && (
        <>
          <h2>Queries</h2>
          <input id="query-search" className="search" type="search" value={search}
                 placeholder="Search label, file or table"
                 aria-label="Search queries by label, file, table or fingerprint"
                 onChange={(e) => dispatch({ type: "searched", text: e.target.value })} />
          {!shapes.length && <div className="nomatch">No query matches “{search}”.</div>}
          {prefix && <div className="prefix">{prefix}</div>}
          {shapes.map((row) => (
            <div className="shape" key={row.fingerprint}>
              {row.runs.length > 1 && (
                <div className="fp"><span>{row.fingerprint}</span><span>{row.runs.length} runs</span></div>
              )}
              {row.runs.map((p) => {
                const inner = row.inner.get(p.query_id) ?? [];
                return (
                  <div key={p.query_id}>
                    <Run profile={p} prefix={prefix} queryId={queryId} dispatch={dispatch}
                         extra={inner.length ? ` · ${inner.length} inside` : ""} />
                    {inner.length > 0 && <Inner runs={inner} prefix={prefix} queryId={queryId} dispatch={dispatch} />}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      )}
    </aside>
  );
}
