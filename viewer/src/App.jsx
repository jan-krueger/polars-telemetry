import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import PlanPane from "./components/PlanPane";
import NodeDetails from "./components/NodeDetails";
import Help from "./components/Help";
import Code from "./components/Code";
import ShareDialog from "./components/ShareDialog";
import { SessionSwitcher, SessionsPage } from "./components/Sessions";
import { byNode, warned } from "./lib/insights";
import Tip, { TipText } from "./components/Tip";
import { dropSession, listSessions, loadDocuments, saveInfo, saveSession, storageUnavailable } from "./lib/storage";
import { busy, bytes, compact, diagnostics, num, shapeName, span, tableName } from "./lib/format";
import { basename } from "./lib/polars";
import { clock, instant, iso, spansDays } from "./lib/time";
import { readJsonl, readProfiles, sessionInfo, toJsonl } from "./model/read";
import { fromHash, isNewPage, routeOf, toHash } from "./state/route";
import { MAX_LINK_CHARS, isShareFragment, openShareFragment, shareFragment } from "./share/link";
import { documentsFor, sharedSession } from "./share/session";
import {
  compareProfile, currentProfile, currentSession, findNode, initialState, reducer, sameRuns,
  sharedPrefix, title, visibleShapes,
} from "./state/viewer";

const EXAMPLES = [
  { file: "tpch-sf1.jsonl", title: "Scale factor 1" },
  { file: "tpch-sf10.jsonl", title: "Scale factor 10" },
];

const VERDICT = { good: "var(--good)", warn: "var(--warn)", crit: "var(--crit)", info: "var(--muted)" };

function Booting({ label }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(timer);
  }, []);
  return <div className="booting" role="status">{slow ? label : null}</div>;
}

const Breakable = ({ text }) =>
  text.split(/(?<=[/._])/).map((part, i) => <span key={i}>{i ? <wbr /> : null}{part}</span>);

function Busy({ profile, compare }) {
  const b = busy(profile);
  if (!b) return null;
  const cpu = compare?.cpu_ms ? ` (${profile.cpu_ms >= compare.cpu_ms ? "+" : ""}${num(((profile.cpu_ms - compare.cpu_ms) / compare.cpu_ms) * 100, 0)}% against the compared run)` : "";
  const note = `${num(profile.cpu_ms, 1)} ms of node CPU over ${num(profile.wall_ms, 1)} ms of wall time${cpu}: `
    + (b.of ? `on average ${num(b.threads, 1)} of the ${b.of} threads polars had were busy, ${num(b.share * 100, 0)}% parallel efficiency.`
      : `on average ${num(b.threads, 1)} threads were busy.`)
    + " Node CPU counts only time polars charges to nodes.";
  return (
    <Tip content={<TipText term="Threads busy">{note}</TipText>}>
      <span className="busy" tabIndex={0}>
        ·{b.share != null && (
          <span className="busy-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(2, b.share * 100)}%`, background: VERDICT[b.verdict] }} />
          </span>
        )}
        <b>{num(b.threads, 1)}</b>{b.of ? <> of {b.of}</> : null} threads busy
      </span>
    </Tip>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  // One file input, opened by the header button and by the drop zone alike.
  const fileInput = useRef(null);
  const chooseFiles = () => fileInput.current?.click();
  const { booted, sessions } = state;
  // What did not import, per file; shown until dismissed or the next import.
  const [rejectedFiles, setRejectedFiles] = useState([]);
  const [sharing, setSharing] = useState(null);
  const [alone, setAlone] = useState(null);
  const toggleAlone = (pane) => setAlone((shown) => (shown === pane ? null : pane));
  const [linked, setLinked] = useState(null);
  const toggleLinked = (pane) => setLinked((leader) => (leader ? null : pane));
  const views = useMemo(() => {
    const listeners = new Set();
    return {
      publish: (view) => listeners.forEach((listener) => listener(view)),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }, []);
  const queryList = useRef(null);

  useEffect(() => {
    (async () => {
      // Stored raw and read on every load, so a newer reader improves old sessions.
      const listed = (await listSessions()) || [];
      dispatch({ type: "loaded", sessions: listed.map((info) => ({ ...info, profiles: null, raw: null })) });
      if (!isShareFragment(location.hash)) {
        dispatch({ type: "navigated", route: fromHash(location.hash) });
        return;
      }
      const opened = openShareFragment(location.hash);
      if ("problem" in opened) {
        setRejectedFiles([`Shared link: ${opened.problem}.`]);
        history.replaceState(null, "", location.pathname + location.search);
        return;
      }
      const shared = sharedSession(location.hash, opened.documents, Date.now());
      dispatch({ type: "imported", sessions: [shared] });
      if (shared.profiles[0]) dispatch({ type: "queryPicked", queryId: shared.profiles[0].query_id });
      if (shared.profiles[1]) dispatch({ type: "comparePicked", queryId: shared.profiles[1].query_id });
    })();
    const back = () => {
      if (!isShareFragment(location.hash)) dispatch({ type: "navigated", route: fromHash(location.hash) });
    };
    addEventListener("popstate", back);
    return () => removeEventListener("popstate", back);
  }, []);

  // The address bar follows what is on screen. A page the address did not
  // name yet (a fresh load, a fallback) is filled in rather than added to
  // history, so the back button never lands on a page that moves straight on.
  useEffect(() => {
    if (!booted) return;
    const open = currentSession(state);
    if (open?.shared) {
      if (location.hash !== open.shared) history.replaceState(null, "", open.shared);
      return;
    }
    const route = routeOf(state);
    const shown = fromHash(location.hash);
    const hash = toHash(route);
    if (hash === toHash(shown)) return;
    const url = hash || location.pathname + location.search;
    if (shown.sessionId && isNewPage(shown, route)) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }, [booted, state.sessions, state.sessionId, state.queryId, state.node]);

  const current = currentSession(state);
  const profiles = current?.profiles ?? [];

  const reading = useRef(null);
  useEffect(() => {
    if (!booted || !current || current.profiles || reading.current === current.id) return;
    const { id, name } = current;
    reading.current = id;
    (async () => {
      const raw = await loadDocuments(id).catch(() => null);
      reading.current = null;
      if (!raw) {
        setRejectedFiles([`${name}: its profiles could not be read from this browser's storage.`]);
        return;
      }
      dispatch({ type: "read", sessionId: id, profiles: readProfiles(raw), raw, forgetOthers: !storageUnavailable() });
    })();
  }, [booted, current]);

  useEffect(() => {
    if (!booted || !current) return;
    const at = Date.now();
    dispatch({ type: "opened", sessionId: current.id, at });
    if (!current.shared) saveInfo(infoOf({ ...current, openedAt: at })).catch(() => {});
  }, [booted, current?.id]);
  const profile = currentProfile(state);
  const compare = compareProfile(state);
  useEffect(() => setSharing(null), [profile?.query_id, compare?.query_id]);
  const withDates = useMemo(() => spansDays(profiles), [profiles]);

  const open = useRef(state.sessions);
  open.current = state.sessions;
  const importFiles = useCallback(async (files) => {
    const added = [];
    const rejected = [];
    let reopened = null;
    for (const f of files) {
      let read;
      try {
        read = readJsonl(await f.text());
      } catch (e) {
        rejected.push(`${f.name}: ${e.message}`);
        continue;
      }
      // Only ever store what reads: a bad profile in IndexedDB would come back
      // on every load.
      if (!read.profiles.length) {
        rejected.push(`${f.name}: ${read.rejected[0] || "no profiles found"}`);
        continue;
      }
      if (read.rejected.length) {
        const n = read.rejected.length;
        rejected.push(`${f.name}: skipped ${n} line${n > 1 ? "s" : ""} (${read.rejected[0]})`);
      }
      const already = sameRuns([...added, ...open.current], read.profiles);
      if (already) {
        reopened = already.id;
        continue;
      }
      const now = Date.now();
      const info = sessionInfo({ id: crypto.randomUUID(), name: f.name, importedAt: now, openedAt: now, bytes: f.size },
                               read.profiles);
      try {
        await saveSession(info, read.raw);
      } catch (e) {
        rejected.push(`${f.name}: open for this page only, not stored (${e?.message ?? e})`);
      }
      added.push({ ...info, profiles: read.profiles, raw: read.raw });
    }
    setRejectedFiles(rejected);
    if (added.length) dispatch({ type: "imported", sessions: added });
    else if (reopened) dispatch({ type: "sessionPicked", sessionId: reopened });
  }, []);

  useEffect(() => {
    const over = (e) => { e.preventDefault(); document.body.classList.add("dragging"); };
    const leave = (e) => { if (e.relatedTarget === null) document.body.classList.remove("dragging"); };
    const drop = (e) => {
      e.preventDefault(); document.body.classList.remove("dragging");
      if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]);
    };
    addEventListener("dragover", over); addEventListener("dragleave", leave); addEventListener("drop", drop);
    return () => { removeEventListener("dragover", over); removeEventListener("dragleave", leave);
                   removeEventListener("drop", drop); };
  }, [importFiles]);

  const pick = (queryId) => dispatch({ type: "queryPicked", queryId });

  const remove = async (sessionIds) => {
    const failed = [];
    for (const id of sessionIds) {
      try {
        await dropSession(id);
      } catch (e) {
        failed.push(`${sessions.find((s) => s.id === id)?.name ?? id}: removed from this page, but still stored (${e?.message ?? e})`);
      }
    }
    if (failed.length) setRejectedFiles(failed);
    dispatch({ type: "removed", sessionIds });
  };

  const save = async (session) => {
    const raw = session.raw ?? (await loadDocuments(session.id).catch(() => null));
    if (raw) download(session.name, raw);
    else setRejectedFiles([`${session.name}: its profiles could not be read from this browser's storage.`]);
  };

  const copyLink = async (fragment) => {
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
    const shown = [profile, compare].filter(Boolean);
    const fragment = shareFragment(documentsFor(current, shown));
    if (fragment.length > MAX_LINK_CHARS) setSharing({ tooLong: fragment.length });
    else if (shown.some((p) => !p.redacted?.length)) setSharing({ confirm: fragment });
    else copyLink(fragment);
  };

  const rename = async (session, typed) => {
    const name = typed.trim();
    if (!name || name === session.name) return;
    dispatch({ type: "renamed", sessionId: session.id, name });
    if (session.shared || storageUnavailable()) return;
    try {
      await saveInfo(infoOf({ ...session, name }));
    } catch (e) {
      setRejectedFiles([`${name}: renamed on this page only, not stored (${e?.message ?? e})`]);
    }
  };

  const keep = async (session) => {
    try {
      await saveSession(infoOf(session), session.raw);
      dispatch({ type: "kept", sessionId: session.id });
    } catch (e) {
      setRejectedFiles([`${session.name}: could not be stored (${e?.message ?? e})`]);
    }
  };

  // Served beside the hosted viewer; opened from disk there is nothing to fetch.
  const loadExample = async ({ file }) => {
    try {
      const response = await fetch(`examples/${file}`);
      if (!response.ok) throw new Error(`${response.status}`);
      await importFiles([new File([await response.blob()], file)]);
    } catch {
      setRejectedFiles([`${file}: examples load only on the hosted viewer. Download it from `
        + "github.com/jan-krueger/polars-telemetry/tree/main/examples and open it here."]);
    }
  };

  // A query picked anywhere -- the overview, a link, the back button -- is
  // brought into view in the list with its other runs, ready to click.
  useEffect(() => {
    const run = queryList.current?.querySelector('.run[aria-pressed="true"]');
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    run?.closest(".shape")?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [state.queryId]);
  const overview = useMemo(() => visibleShapes(state),
    [state.sessions, state.sessionId, state.search, state.sort]);
  const widest = overview.reduce((a, r) => Math.max(a, r.wallMs), 0) || 1;
  const totalWall = overview.reduce((a, r) => a + r.wallMs, 0) || 1;

  const selectedNode = findNode(profile, state.node);
  const compareNode = findNode(compare, state.node);
  const findings = useMemo(() => byNode(profile), [profile]);
  const prefix = useMemo(() => sharedPrefix(profiles), [profiles]);
  const warnings = useMemo(() => warned(profile), [profile]);
  const [reveal, setReveal] = useState(null);
  const showWarning = (id) => {
    dispatch({ type: "nodePicked", node: { plan: "physical", id } });
    setReveal({ id });
  };

  // Other runs of the same shape, which the compare picker offers.
  const siblings = profile
    ? profiles.filter((q) => q.fingerprint === profile.fingerprint && q.query_id !== profile.query_id)
    : [];
  const delta = (a, b) => {
    if (b == null) return null;
    const pct = b ? ((a - b) / b) * 100 : 0;
    if (Math.abs(pct) < 0.5) return <span className="dl" style={{ color: "var(--muted)" }}> =</span>;
    return <span className={`dl ${pct > 0 ? "delta-up" : "delta-down"}`}> {pct > 0 ? "+" : ""}{num(pct, 0)}%</span>;
  };

  return (
    <>
      <header className="top">
        <div className="brand">polars-telemetry <span>· profile viewer</span></div>
        <div className="toolbar">
          {booted && sessions.length ? (
            <button className="link hint" onClick={() => dispatch({ type: "browsed", open: true })}>
              {sessions.length} session{sessions.length > 1 ? "s" : ""} stored
            </button>
          ) : (
            <span className="hint">{!booted ? "" : storageUnavailable() ? "storage unavailable" : "nothing loaded"}</span>
          )}
          <button className="btn" onClick={chooseFiles}>Open .jsonl</button>
          <input ref={fileInput} type="file" accept=".jsonl,.json" multiple hidden
                 onChange={(e) => { if (e.target.files.length) importFiles([...e.target.files]); e.target.value = ""; }} />
        </div>
      </header>

      <div className="shell">
        <aside className="rail" ref={queryList}>
          {sessions.length > 0 && (
            <SessionSwitcher sessions={sessions} current={current} onKeep={keep}
                             onPick={(sessionId) => dispatch({ type: "sessionPicked", sessionId })}
                             onBrowse={() => dispatch({ type: "browsed", open: true })} />
          )}
          {current?.profiles && (
            <>
              <h2>Queries</h2>
              <input id="query-search" className="search" type="search" value={state.search}
                     placeholder="Search label, file or table"
                     aria-label="Search queries by label, file, table or fingerprint"
                     onChange={(e) => dispatch({ type: "searched", text: e.target.value })} />
              {!overview.length && <div className="nomatch">No query matches “{state.search}”.</div>}
              {prefix && <div className="prefix">{prefix}</div>}
              {overview.map((row) => (
                <div className="shape" key={row.fingerprint}>
                  {row.runs.length > 1 && (
                    <div className="fp"><span>{row.fingerprint}</span><span>{row.runs.length} runs</span></div>
                  )}
                  {row.runs.map((p) => (
                    <button key={p.query_id} className="run" aria-pressed={p.query_id === state.queryId}
                            onClick={() => pick(p.query_id)}>
                      <div className="l1"><Breakable text={title(p).slice(prefix.length)} /></div>
                      <div className="l2">{span(p.wall_ms)} wall{p.cpu_ms > 0 ? ` · ${span(p.cpu_ms)} cpu` : ""}</div>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </aside>

        <main>
          {rejectedFiles.length > 0 && (
            <div className="notice" role="alert">
              <div className="notice-text">
                <b>Not everything worked</b>
                {rejectedFiles.map((r) => <div key={r}>{r}</div>)}
              </div>
              <button className="x" aria-label="Dismiss" onClick={() => setRejectedFiles([])}>×</button>
            </div>
          )}
          {!booted ? (
            <Booting label="Loading sessions…" />
          ) : state.browsing ? (
            <SessionsPage sessions={sessions} currentId={state.sessionId} onKeep={keep}
                          storageNote={storageUnavailable() ? " (this page only)" : ""}
                          onPick={(sessionId) => dispatch({ type: "sessionPicked", sessionId })}
                          onClose={() => dispatch({ type: "browsed", open: false })}
                          onRename={rename} onDownload={save} onRemove={remove} />
          ) : current && !current.profiles ? (
            <Booting label={`Opening ${current.name}…`} />
          ) : !current ? (
            <div className="blank">
              <h3>Nothing loaded</h3>
              <p>Profiles stay in this browser. Nothing is uploaded.</p>
              <button className="zone" onClick={chooseFiles}>
                <div className="big">Drop a <code>.jsonl</code> session here, or click to choose one</div>
                <div className="small">several files at once is fine</div>
              </button>
              <div className="examples">
                <span>Or try it with TPC-H, 22 queries run three times each:</span>
                {EXAMPLES.map((e) => (
                  <button key={e.file} className="btn" onClick={() => loadExample(e)}>{e.title}</button>
                ))}
              </div>
              <Code block code={`import polars_telemetry
from polars_telemetry.export.file import FileExporter

polars_telemetry.install(exporter=FileExporter("profiles/session.jsonl"))`} />
            </div>
          ) : !profile ? (
            <>
              <h2>{current.name}</h2>
              <div style={{ fontSize: 15, fontWeight: 600, margin: "-4px 0 4px" }}>
                {profiles.length} profiles · {overview.length} query shape{overview.length > 1 ? "s" : ""}
              </div>
              <table className="ovw">
                <thead><tr>
                  <SortHeader sort={state.sort} by="name" dispatch={dispatch}>query</SortHeader>
                  <SortHeader sort={state.sort} by="runs" dispatch={dispatch}>runs</SortHeader>
                  <SortHeader sort={state.sort} by="wall" dispatch={dispatch}>total wall</SortHeader>
                  <th>share</th>
                  <SortHeader sort={state.sort} by="cpu" dispatch={dispatch}>mean cpu</SortHeader>
                  <th />
                </tr></thead>
                <tbody>
                  {overview.map((r) => (
                    <tr key={r.fingerprint} onClick={() => pick(r.runs[0].query_id)}>
                      <td><div style={{ fontWeight: 500 }}>{title(r.runs[0])}</div>
                        <div style={{ font: "10.5px ui-monospace,monospace", color: "var(--muted)" }}>
                          {r.runs[0].label && tableName(r.runs[0]) ? `${tableName(r.runs[0])} · ` : ""}{r.fingerprint}</div></td>
                      <td>{r.runs.length}</td><td>{span(r.wallMs)}</td>
                      <td>{num((r.wallMs / totalWall) * 100, 1)}%</td><td>{r.cpuMs > 0 ? span(r.cpuMs / r.runs.length) : "—"}</td>
                      <td style={{ width: 140 }}>
                        <div className="bar" style={{ width: `${(r.wallMs / widest) * 100}%` }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
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
                    <select className="picker" style={{ marginLeft: "auto" }}
                            value={state.compareId ?? ""}
                            onChange={(e) => dispatch({ type: "comparePicked", queryId: e.target.value || null })}>
                      <option value="">compare with…</option>
                      {siblings.map((q) => (
                        <option value={q.query_id} key={q.query_id}>
                          {clock(q.started_unix_ns, withDates)} · {span(q.wall_ms)}
                        </option>))}
                    </select>
                  )}
                  <Tip content={compare ? "Copy a link to this query and the run it is compared with" : "Copy a link to this query"}>
                  <button className="btn share" style={siblings.length ? undefined : { marginLeft: "auto" }}
                          onClick={share}>{sharing?.copied ? "Copied" : "Copy link"}</button>
                  </Tip>
                </div>
                {sharing && !sharing.copied && (
                  <ShareDialog sharing={sharing}
                               what={compare ? "query and its comparison run" : "query"}
                               onCopy={copyLink}
                               onDownload={() => { save(current); setSharing(null); }}
                               onClose={() => setSharing(null)} />
                )}
                <div className="qstats">
                  <Tip content={<TipText term="Wall time">{num(profile.wall_ms, 1)} ms from collect() to the result
                    {profile.planning_ms != null ? `, of which ${num(profile.planning_ms, 1)} ms planning` : ""}
                    {profile.telemetry_ms != null ? ` and ${num(profile.telemetry_ms, 1)} ms polars-telemetry` : ""}.</TipText>}>
                    <span tabIndex={0}><b className="qwall">{span(profile.wall_ms)}</b> wall</span>
                  </Tip>
                  {delta(profile.wall_ms, compare?.wall_ms)}
                  <Busy profile={profile} compare={compare} />
                  {profile.result_rows != null && (
                    <span>· <b>{compact(profile.result_rows)}</b> rows out{delta(profile.result_rows, compare?.result_rows)}</span>
                  )}
                  <span className="chips">
                    {diagnostics(profile).map((d) => (
                      <span className="chipd" key={d.t}>
                        <i className="dot" style={{ background: VERDICT[d.s] }} />
                        <span className="lb">{d.t}</span><b>{d.v}{d.u}</b>
                        <Help term={d.k} extra={d.n} />
                      </span>
                    ))}
                  </span>
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
          )}
        </main>

        <aside className="rail right">
          {!state.browsing && (
            <NodeDetails node={selectedNode} compareNode={compareNode}
                         findings={state.node?.plan === "physical" ? findings.get(state.node.id) : undefined} />
          )}
        </aside>
      </div>
    </>
  );
}

/** A column header that sorts the overview, and says how it is sorted. */
function SortHeader({ sort, by, dispatch, children }) {
  const active = sort.key === by;
  return (
    <th aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}>
      <button className="sorth" onClick={() => dispatch({ type: "sorted", key: by })}>
        {children}<span className="sorth-mark" aria-hidden="true">{active ? (sort.descending ? "▼" : "▲") : ""}</span>
      </button>
    </th>
  );
}

/** Save a session as the .jsonl it was imported from. */
function download(name, raw) {
  const url = URL.createObjectURL(new Blob([toJsonl(raw)], { type: "application/jsonl" }));
  const link = Object.assign(document.createElement("a"), {
    href: url, download: name.endsWith(".jsonl") ? name : `${name}.jsonl`,
  });
  link.click();
  URL.revokeObjectURL(url);
}

/** A session's list entry, as storage keeps it. */
function infoOf({ id, name, importedAt, openedAt, bytes, count, runIds, ran }) {
  return { id, name, importedAt, openedAt, bytes, count, runIds, ran };
}
