import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import PlanPane from "./components/PlanPane";
import NodeDetails from "./components/NodeDetails";
import Help from "./components/Help";
import Code from "./components/Code";
import ShareDialog from "./components/ShareDialog";
import Tip, { TipText } from "./components/Tip";
import { allSessions, dropAll, dropSession, saveSession, storageUnavailable } from "./lib/storage";
import { bytes, diagnostics, ms, num, shapeName } from "./lib/format";
import { basename } from "./lib/polars";
import { clock, instant, iso, ranBetween, spansDays } from "./lib/time";
import { readJsonl, readSession, toJsonl } from "./model/read";
import { fromHash, isNewPage, routeOf, toHash } from "./state/route";
import { MAX_LINK_CHARS, isShareFragment, openShareFragment, shareFragment } from "./share/link";
import { documentsFor, sharedSession } from "./share/session";
import {
  compareProfile, currentProfile, currentSession, findNode, initialState, reducer, title,
  visibleShapes,
} from "./state/viewer";

const EXAMPLES = [
  { file: "tpch-sf1.jsonl", title: "Scale factor 1" },
  { file: "tpch-sf10.jsonl", title: "Scale factor 10" },
];

const VERDICT = { good: "var(--good)", warn: "var(--warn)", crit: "var(--crit)", info: "var(--muted)" };

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  // One file input, opened by the header button and by the drop zone alike.
  const fileInput = useRef(null);
  const chooseFiles = () => fileInput.current?.click();
  const { booted, sessions } = state;
  // What did not import, per file; shown until dismissed or the next import.
  const [rejectedFiles, setRejectedFiles] = useState([]);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [sharing, setSharing] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [alone, setAlone] = useState(null);
  const toggleAlone = (pane) => setAlone((shown) => (shown === pane ? null : pane));
  const [linked, setLinked] = useState(false);
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
      const stored = (await allSessions()) || [];
      dispatch({ type: "loaded", sessions: stored.map(readSession) });
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
  const profile = currentProfile(state);
  const compare = compareProfile(state);
  useEffect(() => setSharing(null), [profile?.query_id, compare?.query_id]);
  const withDates = useMemo(() => spansDays(profiles), [profiles]);

  const importFiles = useCallback(async (files) => {
    const added = [];
    const rejected = [];
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
      const meta = { id: crypto.randomUUID(), name: f.name, importedAt: Date.now(), bytes: f.size };
      try {
        await saveSession({ ...meta, profiles: read.raw });
      } catch (e) {
        rejected.push(`${f.name}: open for this page only, not stored (${e?.message ?? e})`);
      }
      added.push({ ...meta, profiles: read.profiles, raw: read.raw });
    }
    setRejectedFiles(rejected);
    if (added.length) dispatch({ type: "imported", sessions: added });
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
    setRenaming(null);
    const name = typed.trim();
    if (!name || name === session.name) return;
    dispatch({ type: "renamed", sessionId: session.id, name });
    if (session.shared || storageUnavailable()) return;
    try {
      await saveSession(stored({ ...session, name }));
    } catch (e) {
      setRejectedFiles([`${name}: renamed on this page only, not stored (${e?.message ?? e})`]);
    }
  };

  const keep = async (session) => {
    try {
      await saveSession(stored(session));
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

  // Other runs of the same shape, which the compare picker offers.
  const siblings = profile
    ? profiles.filter((q) => q.fingerprint === profile.fingerprint && q.query_id !== profile.query_id)
    : [];
  const totalBytes = sessions.reduce((a, s) => a + (s.bytes || 0), 0);
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
          <span className="hint">
            {!booted ? "" : sessions.length
              ? `${sessions.length} session${sessions.length > 1 ? "s" : ""} stored`
              : storageUnavailable() ? "storage unavailable" : "nothing loaded"}
          </span>
          <button className="btn" onClick={chooseFiles}>Open .jsonl</button>
          <input ref={fileInput} type="file" accept=".jsonl,.json" multiple hidden
                 onChange={(e) => { if (e.target.files.length) importFiles([...e.target.files]); e.target.value = ""; }} />
        </div>
      </header>

      <div className="shell">
        <aside className="rail" ref={queryList}>
          {sessions.length > 0 && (
            <>
              <h2>Sessions</h2>
              {sessions.map((s) => (
                <div className="sessrow" key={s.id} aria-current={s.id === state.sessionId}>
                  {renaming === s.id ? (
                    <div className="pick">
                      <input className="rename" id={`rename-${s.id}`} aria-label={`New name for ${s.name}`}
                             defaultValue={s.name} autoFocus onFocus={(e) => e.target.select()}
                             onBlur={(e) => (e.target.dataset.cancel ? setRenaming(null) : rename(s, e.target.value))}
                             onKeyDown={(e) => {
                               if (e.key === "Escape") e.currentTarget.dataset.cancel = "1";
                               if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                             }} />
                      <SessionMeta session={s} />
                    </div>
                  ) : (
                    <button className="pick" onClick={() => dispatch({ type: "sessionPicked", sessionId: s.id })}
                            onDoubleClick={() => setRenaming(s.id)}
                            onKeyDown={(e) => { if (e.key === "F2") setRenaming(s.id); }}>
                      <Tip content="Double-click to rename">
                      <div className="nm">{s.name}</div>
                      </Tip>
                      <SessionMeta session={s} />
                    </button>
                  )}
                  {s.shared && (
                    <Tip content="Store this session in this browser">
                    <button className="link keep" onClick={() => keep(s)}>Keep</button>
                    </Tip>
                  )}
                  <Tip content="Download this session">
                  <button className="x dl" aria-label={`Download ${s.name}`}
                          onClick={() => download(s)}>
                    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none"
                         stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
                    </svg>
                  </button>
                  </Tip>
                  <Tip content="Remove this session">
                  <button className="x" aria-label={`Remove ${s.name}`}
                          onClick={async () => {
                            try {
                              await dropSession(s.id);
                            } catch (e) {
                              setRejectedFiles([`${s.name}: removed from this page, but still stored (${e?.message ?? e})`]);
                            }
                            dispatch({ type: "removed", sessionId: s.id });
                          }}>×</button>
                  </Tip>
                </div>
              ))}
              {confirmingClear ? (
                <div className="railfoot" role="alert">
                  <span>Remove all {sessions.length} sessions?</span>
                  <span className="railfoot-actions">
                    <button className="link link--crit" onClick={async () => {
                      try {
                        await dropAll();
                      } catch (e) {
                        setRejectedFiles([`Sessions removed from this page, but still stored (${e?.message ?? e})`]);
                      }
                      setConfirmingClear(false); dispatch({ type: "cleared" });
                    }}>Remove</button>
                    <button className="link" onClick={() => setConfirmingClear(false)}>Keep</button>
                  </span>
                </div>
              ) : (
                <div className="railfoot">
                  <span>{bytes(totalBytes)} stored{storageUnavailable() ? " (this session only)" : ""}</span>
                  <button className="link" onClick={() => setConfirmingClear(true)}>Clear all</button>
                </div>
              )}
            </>
          )}
          {current && (
            <>
              <h2>Queries</h2>
              <input id="query-search" className="search" type="search" value={state.search}
                     placeholder="Search label, file or table"
                     aria-label="Search queries by label, file, table or fingerprint"
                     onChange={(e) => dispatch({ type: "searched", text: e.target.value })} />
              {!overview.length && <div className="nomatch">No query matches “{state.search}”.</div>}
              {overview.map((row) => (
                <div className="shape" key={row.fingerprint}>
                  <div className="fp"><span>{row.fingerprint}</span>
                    <span>{row.runs.length} run{row.runs.length > 1 ? "s" : ""}</span></div>
                  {row.runs.map((p) => (
                    <button key={p.query_id} className="run" aria-pressed={p.query_id === state.queryId}
                            onClick={() => pick(p.query_id)}>
                      <div className="l1">{title(p)}</div>
                      <div className="l2">{ms(p.wall_ms)} wall · {ms(p.cpu_ms)} cpu</div>
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
          {!current ? (
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
                          {r.runs[0].label ? `${shapeName(r.runs[0])} · ` : ""}{r.fingerprint}</div></td>
                      <td>{r.runs.length}</td><td>{ms(r.wallMs)}</td>
                      <td>{num((r.wallMs / totalWall) * 100, 1)}%</td><td>{ms(r.cpuMs / r.runs.length)}</td>
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
                  <span className="qmeta">{profile.label ? `${shapeName(profile)} · ` : ""}{profile.fingerprint} ·{" "}
                    <Tip content={instant(profile.started_unix_ns)}>
                      <time dateTime={iso(profile.started_unix_ns)} tabIndex={0}>
                        {clock(profile.started_unix_ns, withDates)}</time>
                    </Tip></span>
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
                          {clock(q.started_unix_ns, withDates)} · {ms(q.wall_ms)}
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
                               onDownload={() => { download(current); setSharing(null); }}
                               onClose={() => setSharing(null)} />
                )}
                <div className="qstats">
                  <b>{num(profile.wall_ms, 1)} ms</b> wall{delta(profile.wall_ms, compare?.wall_ms)} ·{" "}
                  <b>{num(profile.cpu_ms, 1)} ms</b> cpu{delta(profile.cpu_ms, compare?.cpu_ms)} ·{" "}
                  <b>{profile.plan.physical.length}</b> nodes ·{" "}
                  <b>{num(profile.result_rows ?? 0)}</b> rows out · polars {profile.polars_version}
                  {profile.redacted?.length ? (
                    <Tip content={<TipText term="Masked before export">Values such as {'"<str>"'} and {"<num>"} are placeholders, not your data.</TipText>}>
                      <span className="masked" tabIndex={0}>
                        {" "}· masked: {profile.redacted.join(", ").replace("_", " ")}</span>
                    </Tip>
                  ) : null}
                </div>
                {profile.failed && (
                  <div className="qfail" role="alert"><b>Failed</b> {profile.failed}</div>
                )}
                <div className="chips">
                  {diagnostics(profile).map((d) => (
                    <span className="chipd" key={d.t}>
                      <i className="dot" style={{ background: VERDICT[d.s] }} />
                      <span className="lb">{d.t}</span><b>{d.v}{d.u}</b>
                      <Help term={d.k} extra={d.n} />
                    </span>
                  ))}
                </div>
              </div>

              <div className={alone ? `plans alone-${alone}` : "plans"}>
                <PlanPane key={`logical-${profile.query_id}`} title="Logical plan"
                          plan={profile.plan.logical} logical
                          alone={alone === "logical"} onAlone={() => toggleAlone("logical")}
                          linked={linked} onLink={() => setLinked((on) => !on)} channel={views}
                          selectedId={state.node?.plan === "logical" ? state.node.id : null}
                          onSelect={(id) => dispatch({ type: "nodePicked", node: { plan: "logical", id } })} />
                <PlanPane key={`physical-${profile.query_id}`} title="Physical plan"
                          plan={profile.plan.physical} logical={false}
                          alone={alone === "physical"} onAlone={() => toggleAlone("physical")}
                          linked={linked} onLink={() => setLinked((on) => !on)} channel={views}
                          focus={state.focus} onFocus={(focus) => dispatch({ type: "focused", focus })}
                          selectedId={state.node?.plan === "physical" ? state.node.id : null}
                          onSelect={(id) => dispatch({ type: "nodePicked", node: { plan: "physical", id } })} />
              </div>
            </>
          )}
        </main>

        <aside className="rail right">
          <NodeDetails node={selectedNode} compareNode={compareNode} />
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
function download(session) {
  const url = URL.createObjectURL(new Blob([toJsonl(session.raw)], { type: "application/jsonl" }));
  const link = Object.assign(document.createElement("a"), {
    href: url, download: session.name.endsWith(".jsonl") ? session.name : `${session.name}.jsonl`,
  });
  link.click();
  URL.revokeObjectURL(url);
}

function stored(session) {
  return { id: session.id, name: session.name, importedAt: session.importedAt,
           bytes: session.bytes, profiles: session.raw };
}

function SessionMeta({ session }) {
  return (
    <>
      <div className="mt">{session.profiles.length} profiles · {bytes(session.bytes || 0)}</div>
      <div className="mt">{session.shared ? "opened from a link, not stored" : ranBetween(session.profiles)
        ?? `imported ${new Date(session.importedAt).toLocaleDateString()}`}</div>
    </>
  );
}
