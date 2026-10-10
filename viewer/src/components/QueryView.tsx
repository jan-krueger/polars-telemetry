import { useEffect, useMemo, useState, type Dispatch } from "react";
import type { Finding, Profile, Session } from "../model/profile";
import type { Panes } from "../hooks/usePanes";
import { busy, inputs, num, span } from "../lib/format";
import { warned } from "../lib/insights";
import { basename } from "../lib/polars";
import { clock, iso, spansDays } from "../lib/time";
import { queryMarkdown } from "../lib/markdown";
import { warnsUnmasked } from "../lib/prefs";
import { MAX_LINK_CHARS, shareFragment } from "../share/link";
import { documentsFor } from "../share/session";
import { title, type Action, type ViewerState } from "../state/viewer";
import PlanPane from "./PlanPane";
import ReplayBar from "./ReplayBar";
import type { Moment } from "../lib/replay";
import ShareDialog, { type Copy, type Sharing } from "./ShareDialog";
import ShareMenu from "./ShareMenu";
import Tip, { TipText } from "./Tip";

interface Props {
  state: ViewerState;
  dispatch: Dispatch<Action>;
  session: Session;
  profile: Profile;
  /** While replaying, the counters at that moment; null shows how the query ended. */
  moment: Moment | null;
  findings: Map<number, Finding[]>;
  panes: Panes;
  onDownload: (session: Session) => void;
}

export default function QueryView({ state, dispatch, session, profile, moment, findings, panes, onDownload }: Props) {
  const now = moment ? { ...profile, wall_ms: moment.t, cpu_ms: moment.cpu_ms } : profile;
  const profiles = session.profiles ?? [];
  const withDates = useMemo(() => spansDays(profiles), [profiles]);
  const warnings = useMemo(() => warned(profile), [profile]);
  const [reveal, setReveal] = useState<{ id: number } | null>(null);
  const [sharing, setSharing] = useState<Sharing | null>(null);
  useEffect(() => setSharing(null), [profile.query_id]);
  const { alone, toggleAlone, linked, toggleLinked, views } = panes;

  const unmasked = !profile.redacted?.length && warnsUnmasked();

  const copy = async (what: Copy, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSharing({ copied: what });
      setTimeout(() => setSharing((s) => (s?.copied === what ? null : s)), 2000);
    } catch {
      setSharing({ manual: { copy: what, text } });
    }
  };

  const copyLink = (url: string) => {
    if (unmasked) setSharing({ confirm: { copy: "link", text: url } });
    else copy("link", url);
  };

  const share = () => {
    const fragment = shareFragment(documentsFor(session, [profile]));
    const url = location.href.split("#")[0] + fragment;
    if (fragment.length > MAX_LINK_CHARS) setSharing({ tooLong: { chars: fragment.length, text: url } });
    else copyLink(url);
  };

  const markdown = () => {
    const text = queryMarkdown(profile);
    if (unmasked) setSharing({ confirm: { copy: "markdown", text } });
    else copy("markdown", text);
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
          <Tip content={<Facts profile={profile} withDates={withDates} />}>
            <span className="qinfo" tabIndex={0} aria-label="About this query">
              <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor"
                   strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="6" /><path d="M8 7.3v3.7M8 5v.1" /></svg>
            </span>
          </Tip>
          <div className="qstats">
            <Tip content={<TipText term="Wall time">{num(now.wall_ms, 1)} ms {moment ? "into the run" : "from collect() to the result"}
              {profile.planning_ms != null ? `, of which ${num(profile.planning_ms, 1)} ms planning` : ""}
              {profile.telemetry_ms != null ? ` and ${num(profile.telemetry_ms, 1)} ms polars-telemetry` : ""}.</TipText>}>
              <span tabIndex={0}><b className="qwall">{span(now.wall_ms)}</b> wall</span>
            </Tip>
            <Busy profile={now} />
            {profile.diagnostics?.incomplete_nodes ? (
              <Tip content={<TipText term="Counters incomplete">{String(profile.diagnostics.incomplete_nodes)} nodes had not finished reporting when the query ended, so their figures are a floor, not a total.</TipText>}>
                <span className="masked" tabIndex={0}>· incomplete</span>
              </Tip>
            ) : null}
            {profile.redacted?.length ? (
              <Tip content={<TipText term={`Masked: ${profile.redacted.join(", ").replace("_", " ")}`}>Values such as {'"<str>"'} and {"<num>"} are placeholders, not your data.</TipText>}>
                <span className="masked" tabIndex={0}>· masked</span>
              </Tip>
            ) : null}
          </div>
          <ShareMenu done={sharing?.copied === "link" ? "Link copied" : sharing?.copied === "markdown" ? "Markdown copied" : null} options={[
            { key: "link", label: "Copy link", onPick: share, note: "Opens this query in the viewer" },
            { key: "markdown", label: "Copy as Markdown", onPick: markdown, note: "Figures, findings and plan, for an issue" },
            { key: "download", label: "Download session", onPick: () => onDownload(session),
              note: "Every query in it, as the .jsonl file" },
          ]} />
        </div>
        {sharing && !sharing.copied && (
          <ShareDialog sharing={sharing} what="query"
                       onCopy={copy} onCopyLong={copyLink}
                       onDownload={() => { onDownload(session); setSharing(null); }}
                       onClose={() => setSharing(null)} />
        )}
        {profile.failed && (
          <div className="qfail" role="alert"><b>Failed</b> {profile.failed}</div>
        )}
        {profile.unfinished && (
          <div className="qnote">Still running when the recording ended; its counters are from the last sample.</div>
        )}
      </div>

      {profile.replay && <ReplayBar profile={profile} at={state.replayAt} dispatch={dispatch} />}

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
                  focus={state.focus} onFocus={(focus) => dispatch({ type: "focused", focus })} moment={moment}
                  selectedId={state.node?.plan === "physical" ? state.node.id : null}
                  onSelect={(id) => dispatch({ type: "nodePicked", node: { plan: "physical", id } })} />
      </div>
    </>
  );
}

function Facts({ profile, withDates }: { profile: Profile; withDates: boolean }) {
  const reads = inputs(profile);
  return (
    <dl className="qfacts">
      {reads.length > 0 && <><dt>Reads</dt><dd>{reads.map((name) => <div key={name}>{name}</div>)}</dd></>}
      <dt>Shape</dt><dd>{profile.fingerprint}</dd>
      <dt>Started</dt><dd>{clock(profile.started_unix_ns, withDates)} <span className="qfacts-note">{iso(profile.started_unix_ns)}</span></dd>
      {profile.result_rows != null && <><dt>Rows returned</dt><dd>{num(profile.result_rows)}</dd></>}
      <dt>Polars</dt><dd>{profile.polars_version}</dd>
      {profile.call_site && (
        <><dt>Ran at</dt><dd>{basename(profile.call_site.filepath)}:{profile.call_site.lineno} in {profile.call_site.function}()
          <span className="qfacts-note">{profile.call_site.filepath}</span></dd></>
      )}
    </dl>
  );
}

function Busy({ profile }: { profile: Profile }) {
  const b = busy(profile);
  if (!b) return null;
  const note = `${num(profile.cpu_ms, 1)} ms of node CPU over ${num(profile.wall_ms, 1)} ms of wall time: `
    + (b.of && b.share != null ? `on average ${num(b.threads, 1)} of the ${b.of} threads Polars had were busy, ${num(b.share * 100, 0)}% parallel efficiency.`
      : `on average ${num(b.threads, 1)} threads were busy.`)
    + " Node CPU counts only time Polars charges to nodes.";
  return (
    <Tip content={<TipText term="Threads busy">{note}</TipText>}>
      <span className="busy" tabIndex={0}>
        ·{b.share != null && (
          <span className="busy-bar" aria-hidden="true">
            <span className={`busy-fill busy-fill--${b.verdict}`} style={{ width: `${Math.max(2, b.share * 100)}%` }} />
          </span>
        )}
        <span><b>{num(b.threads, 1)}</b>{b.of ? `/${b.of}` : ""} threads</span>
      </span>
    </Tip>
  );
}
