import { useEffect, useMemo, useState, type Dispatch, type ReactNode } from "react";
import type { Finding, Profile } from "../model/profile";
import type { Panes } from "../hooks/usePanes";
import { inputs, num, span } from "../lib/format";
import { warned } from "../lib/insights";
import { basename } from "../lib/polars";
import { clock, iso } from "../lib/time";
import { queryMarkdown } from "../lib/markdown";
import { warnsUnmasked } from "../lib/prefs";
import { MAX_LINK_CHARS } from "../share/link";
import { title, type NodeRef, type QueryAction } from "../state/viewer";
import PlanPane from "./PlanPane";
import ReplayBar from "./ReplayBar";
import { replayEnd, type Moment } from "../lib/replay";
import ShareDialog, { type Copy, type Sharing } from "./ShareDialog";
import ShareMenu from "./ShareMenu";
import Tip, { TipText } from "./Tip";

export interface QueryShare {
  link: () => { url: string; chars: number };
  linkNote: string;
  download: { label: string; note: string; run: () => void };
}

interface Props {
  profile: Profile;
  /** While replaying, the counters at that moment; null shows how the query ended. */
  moment: Moment | null;
  findings: Map<number, Finding[]>;
  panes: Panes;
  node: NodeRef | null;
  focus: number | null;
  replayAt: number | null;
  dispatch: Dispatch<QueryAction>;
  withDates: boolean;
  share: QueryShare;
  heading?: ReactNode;
  extra?: ReactNode;
  live?: boolean;
  /** Replaces the note shown when the recording ends before the query did. */
  cutOff?: string;
}

export default function QueryView({ profile, moment, findings, panes, node, focus, replayAt, dispatch, withDates, share: sharer, heading, extra, live = false, cutOff }: Props) {
  const now = moment ? { ...profile, wall_ms: moment.t, cpu_ms: moment.cpu_ms } : profile;
  const warnings = useMemo(() => warned(profile), [profile]);
  const [reveal, setReveal] = useState<{ id: number } | null>(null);
  const [sharing, setSharing] = useState<Sharing | null>(null);
  useEffect(() => setSharing(null), [profile.query_id]);
  const { toggleAlone, show, linked, toggleLinked, views } = panes;
  const alone = profile.plan.physical.length ? panes.alone : "logical";
  const switcher = (pane: "logical" | "physical") => alone && profile.plan.physical.length ? (
    <span className="pane-tabs" role="tablist">
      {(["physical", "logical"] as const).map((p) => (
        <button key={p} role="tab" aria-selected={p === pane} onClick={() => show(p)}>{p === "physical" ? "Physical plan" : "Logical plan"}</button>
      ))}
    </span>
  ) : undefined;

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
    const { url, chars } = sharer.link();
    if (chars > MAX_LINK_CHARS) setSharing({ tooLong: { chars, text: url } });
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
          {heading ?? <span className="qname">{title(profile)}</span>}
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
            {extra}
          </div>
          <ShareMenu done={sharing?.copied === "link" ? "Link copied" : sharing?.copied === "markdown" ? "Markdown copied" : null} options={[
            { key: "link", label: "Copy link", onPick: share, note: sharer.linkNote },
            { key: "markdown", label: "Copy as Markdown", onPick: markdown, note: "Figures, findings and plan, for an issue" },
            { key: "download", label: sharer.download.label, onPick: sharer.download.run, note: sharer.download.note },
          ]} />
        </div>
        {sharing && !sharing.copied && (
          <ShareDialog sharing={sharing} what="query"
                       onCopy={copy} onCopyLong={copyLink}
                       download={sharer.download.label}
                       onDownload={() => { sharer.download.run(); setSharing(null); }}
                       onClose={() => setSharing(null)} />
        )}
        {profile.failed && <Failure message={profile.failed} />}
        {profile.unfinished && !live && (
          <div className="qnote">{cutOff ?? "Still running when the recording ended; its counters are from the last sample."}</div>
        )}
      </div>

      {profile.replay && replayEnd(profile) > 0 && <ReplayBar key={profile.query_id} profile={profile} at={replayAt} dispatch={dispatch} live={live} />}

      {!profile.plan.logical.length && !profile.plan.physical.length ? (
        <div className="noplan">{profile.failed ? "Polars failed before it built a plan, so there is nothing to draw."
          : live ? "Waiting for the plan…" : "This recording has no plan."}</div>
      ) : (
      <div className={alone ? `plans alone-${alone}` : "plans"}>
        <PlanPane key={`logical-${profile.query_id}`} title="Logical plan" switcher={switcher("logical")}
                  plan={profile.plan.logical} logical
                  alone={alone === "logical"} onAlone={() => toggleAlone("logical")}
                  linked={!!linked} leads={linked === "logical"} onLink={() => toggleLinked("logical")} channel={views}
                  selectedId={node?.plan === "logical" ? node.id : null}
                  onSelect={(id) => dispatch({ type: "nodePicked", node: { plan: "logical", id } })} />
        <PlanPane key={`physical-${profile.query_id}`} title="Physical plan" switcher={switcher("physical")}
                  plan={profile.plan.physical} logical={false}
                  alone={alone === "physical"} onAlone={() => toggleAlone("physical")}
                  linked={!!linked} leads={linked === "physical"} onLink={() => toggleLinked("physical")} channel={views}
                  findings={findings} reveal={reveal} warnings={warnings} onWarning={showWarning}
                  focus={focus} onFocus={(focus) => dispatch({ type: "focused", focus })} moment={moment}
                  selectedId={node?.plan === "physical" ? node.id : null}
                  onSelect={(id) => dispatch({ type: "nodePicked", node: { plan: "physical", id } })} />
      </div>
      )}
    </>
  );
}

function Failure({ message }: { message: string }) {
  const [head, ...rest] = message.trim().split("\n");
  const details = rest.join("\n").trim();
  return (
    <div className="qfail" role="alert">
      <b>Failed</b> {head}
      {details && <pre>{details}</pre>}
    </div>
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
      <IoFact profile={profile} />
      <dt>Polars</dt><dd>{profile.polars_version}</dd>
      {profile.call_site && (
        <><dt>Ran at</dt><dd>{basename(profile.call_site.filepath)}:{profile.call_site.lineno} in {profile.call_site.function}()
          <span className="qfacts-note">{profile.call_site.filepath}</span></dd></>
      )}
    </dl>
  );
}

function IoFact({ profile }: { profile: Profile }) {
  const io = profile.query_metrics;
  const any = io?.io_total_active_ns;
  if (any == null) return null;
  const ms = any / 1e6;
  const rx = io?.io_rx_active_ns, tx = io?.io_tx_active_ns;
  return (
    <><dt>IO in flight</dt><dd>{span(ms)}{profile.wall_ms > 0 ? `, ${num(Math.min(1, ms / profile.wall_ms) * 100, 0)}% of wall` : ""}
      {rx != null && tx != null && <span className="qfacts-note">reading {span(rx / 1e6)}, sending {span(tx / 1e6)}</span>}</dd></>
  );
}
