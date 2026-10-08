import { useEffect, useMemo, useState, type Dispatch } from "react";
import type { Finding, Profile, Session } from "../model/profile";
import type { Panes } from "../hooks/usePanes";
import { busy, compact, num, span, tableName } from "../lib/format";
import { warned } from "../lib/insights";
import { basename } from "../lib/polars";
import { clock, instant, iso, spansDays } from "../lib/time";
import { MAX_LINK_CHARS, shareFragment } from "../share/link";
import { documentsFor } from "../share/session";
import { title, type Action, type ViewerState } from "../state/viewer";
import PlanPane from "./PlanPane";
import ShareDialog, { type Sharing } from "./ShareDialog";
import Tip, { TipText } from "./Tip";

interface Props {
  state: ViewerState;
  dispatch: Dispatch<Action>;
  session: Session;
  profile: Profile;
  compare: Profile | null;
  findings: Map<number, Finding[]>;
  panes: Panes;
  onDownload: (session: Session) => void;
}

/** One query: what it cost, against another run of it if picked, and both its plans. */
export default function QueryView({ state, dispatch, session, profile, compare, findings, panes, onDownload }: Props) {
  const profiles = session.profiles ?? [];
  const withDates = useMemo(() => spansDays(profiles), [profiles]);
  const warnings = useMemo(() => warned(profile), [profile]);
  const [reveal, setReveal] = useState<{ id: number } | null>(null);
  const [sharing, setSharing] = useState<Sharing | null>(null);
  useEffect(() => setSharing(null), [profile.query_id, compare?.query_id]);
  const { alone, toggleAlone, linked, toggleLinked, views } = panes;

  // Other runs of the same shape, which the compare picker offers.
  const siblings = profiles.filter((q) => q.fingerprint === profile.fingerprint && q.query_id !== profile.query_id);

  const copyLink = async (fragment: string) => {
    const url = location.href.split("#")[0] + fragment;
    try {
      await navigator.clipboard.writeText(url);
      setSharing({ copied: true });
      setTimeout(() => setSharing((s) => (s?.copied ? null : s)), 2000);
    } catch {
      setSharing({ manual: url });
    }
  };

  const share = () => {
    const shown = compare ? [profile, compare] : [profile];
    const fragment = shareFragment(documentsFor(session, shown));
    if (fragment.length > MAX_LINK_CHARS) setSharing({ tooLong: fragment.length });
    else if (shown.some((p) => !p.redacted?.length)) setSharing({ confirm: fragment });
    else copyLink(fragment);
  };

  const showWarning = (id: number) => {
    dispatch({ type: "nodePicked", node: { plan: "physical", id } });
    setReveal({ id });
  };

  return (
    <>
      <div className="qhead">
        <div className="qline">
          <span className="qname">{title(profile)}</span>
          <span className="qmeta">{profile.label && tableName(profile) ? `${tableName(profile)} · ` : ""}{profile.fingerprint} ·{" "}
            <Tip content={instant(profile.started_unix_ns)}>
              <time dateTime={iso(profile.started_unix_ns)} tabIndex={0}>
                {clock(profile.started_unix_ns, withDates)}</time>
            </Tip> · polars {profile.polars_version}</span>
          {profile.call_site && (
            <Tip content={profile.call_site.filepath}>
            <span className="qsite" tabIndex={0}>
              {basename(profile.call_site.filepath)}:{profile.call_site.lineno}
              {" in "}{profile.call_site.function}()
            </span>
            </Tip>
          )}
          {siblings.length > 0 && (
            <select className="picker" value={state.compareId ?? ""}
                    onChange={(e) => dispatch({ type: "comparePicked", queryId: e.target.value || null })}>
              <option value="">compare with…</option>
              {siblings.map((q) => (
                <option value={q.query_id} key={q.query_id}>
                  {clock(q.started_unix_ns, withDates)} · {span(q.wall_ms)}
                </option>))}
            </select>
          )}
          <Tip content={compare ? "Copy a link to this query and the run it is compared with" : "Copy a link to this query"}>
          <button className="btn share" onClick={share}>{sharing?.copied ? "Copied" : "Copy link"}</button>
          </Tip>
        </div>
        {sharing && !sharing.copied && (
          <ShareDialog sharing={sharing}
                       what={compare ? "query and its comparison run" : "query"}
                       onCopy={copyLink}
                       onDownload={() => { onDownload(session); setSharing(null); }}
                       onClose={() => setSharing(null)} />
        )}
        <div className="qstats">
          <Tip content={<TipText term="Wall time">{num(profile.wall_ms, 1)} ms from collect() to the result
            {profile.planning_ms != null ? `, of which ${num(profile.planning_ms, 1)} ms planning` : ""}
            {profile.telemetry_ms != null ? ` and ${num(profile.telemetry_ms, 1)} ms polars-telemetry` : ""}.</TipText>}>
            <span tabIndex={0}><b className="qwall">{span(profile.wall_ms)}</b> wall</span>
          </Tip>
          <Delta now={profile.wall_ms} before={compare?.wall_ms} />
          <Busy profile={profile} compare={compare} />
          {profile.result_rows != null && (
            <span>· <b>{compact(profile.result_rows)}</b> rows out<Delta now={profile.result_rows} before={compare?.result_rows} /></span>
          )}
          {profile.diagnostics?.incomplete_nodes ? (
            <Tip content={<TipText term="Counters incomplete">{String(profile.diagnostics.incomplete_nodes)} nodes had not finished reporting when the query ended, so their figures are a floor, not a total.</TipText>}>
              <span className="masked" tabIndex={0}>· counters incomplete</span>
            </Tip>
          ) : null}
          {profile.redacted?.length ? (
            <Tip content={<TipText term="Masked before export">Values such as {'"<str>"'} and {"<num>"} are placeholders, not your data.</TipText>}>
              <span className="masked" tabIndex={0}>
                · masked: {profile.redacted.join(", ").replace("_", " ")}</span>
            </Tip>
          ) : null}
        </div>
        {profile.failed && (
          <div className="qfail" role="alert"><b>Failed</b> {profile.failed}</div>
        )}
      </div>

      <div className={alone ? `plans alone-${alone}` : "plans"}>
        <PlanPane key={`logical-${profile.query_id}`} title="Logical plan"
                  plan={profile.plan.logical} logical
                  alone={alone === "logical"} onAlone={() => toggleAlone("logical")}
                  linked={!!linked} leads={linked === "logical"} onLink={() => toggleLinked("logical")} channel={views}
                  selectedId={state.node?.plan === "logical" ? state.node.id : null}
                  onSelect={(id) => dispatch({ type: "nodePicked", node: { plan: "logical", id } })} />
        <PlanPane key={`physical-${profile.query_id}`} title="Physical plan"
                  plan={profile.plan.physical} logical={false}
                  alone={alone === "physical"} onAlone={() => toggleAlone("physical")}
                  linked={!!linked} leads={linked === "physical"} onLink={() => toggleLinked("physical")} channel={views}
                  findings={findings} reveal={reveal} warnings={warnings} onWarning={showWarning}
                  focus={state.focus} onFocus={(focus) => dispatch({ type: "focused", focus })}
                  selectedId={state.node?.plan === "physical" ? state.node.id : null}
                  onSelect={(id) => dispatch({ type: "nodePicked", node: { plan: "physical", id } })} />
      </div>
    </>
  );
}

function Delta({ now, before }: { now: number; before: number | null | undefined }) {
  if (before == null) return null;
  const pct = before ? ((now - before) / before) * 100 : 0;
  if (Math.abs(pct) < 0.5) return <span className="dl dl--same"> =</span>;
  return <span className={`dl ${pct > 0 ? "delta-up" : "delta-down"}`}> {pct > 0 ? "+" : ""}{num(pct, 0)}%</span>;
}

function Busy({ profile, compare }: { profile: Profile; compare: Profile | null }) {
  const b = busy(profile);
  if (!b) return null;
  const cpu = compare?.cpu_ms ? ` (${profile.cpu_ms >= compare.cpu_ms ? "+" : ""}${num(((profile.cpu_ms - compare.cpu_ms) / compare.cpu_ms) * 100, 0)}% against the compared run)` : "";
  const note = `${num(profile.cpu_ms, 1)} ms of node CPU over ${num(profile.wall_ms, 1)} ms of wall time${cpu}: `
    + (b.of && b.share != null ? `on average ${num(b.threads, 1)} of the ${b.of} threads polars had were busy, ${num(b.share * 100, 0)}% parallel efficiency.`
      : `on average ${num(b.threads, 1)} threads were busy.`)
    + " Node CPU counts only time polars charges to nodes.";
  return (
    <Tip content={<TipText term="Threads busy">{note}</TipText>}>
      <span className="busy" tabIndex={0}>
        ·{b.share != null && (
          <span className="busy-bar" aria-hidden="true">
            <span className={`busy-fill busy-fill--${b.verdict}`} style={{ width: `${Math.max(2, b.share * 100)}%` }} />
          </span>
        )}
        <b>{num(b.threads, 1)}</b>{b.of ? <> of {b.of}</> : null} threads busy
      </span>
    </Tip>
  );
}
