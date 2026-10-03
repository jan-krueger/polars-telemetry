import { useCallback, useEffect, useMemo, useReducer } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import PlanPane from "./components/PlanPane";
import NodeDetails from "./components/NodeDetails";
import Help from "./components/Help";
import { allSessions, dropAll, dropSession, saveSession, storageUnavailable } from "./lib/storage";
import { bytes, diagnostics, ms, num, shapeName } from "./lib/format";
import { readJsonl, readSession } from "./model/read";
import {
  compareProfile, currentProfile, currentSession, findNode, initialState, reducer, shapes,
} from "./state/viewer";

const VERDICT = { good: "var(--good)", warn: "var(--warn)", crit: "var(--crit)", info: "var(--muted)" };

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { booted, sessions } = state;

  useEffect(() => {
    (async () => {
      // Stored raw and read on every load, so a newer reader improves old sessions.
      const stored = (await allSessions()) || [];
      dispatch({ type: "loaded", sessions: stored.map(readSession) });
    })();
  }, []);

  const current = currentSession(state);
  const profiles = current?.profiles ?? [];
  const profile = currentProfile(state);
  const compare = compareProfile(state);

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
      const meta = { id: crypto.randomUUID(), name: f.name, importedAt: Date.now(), bytes: f.size };
      await saveSession({ ...meta, profiles: read.raw });
      added.push({ ...meta, profiles: read.profiles });
    }
    if (!added.length) { alert(rejected.join("\n") || "No polars-telemetry profiles found."); return; }
    dispatch({ type: "imported", sessions: added });
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
  const overview = useMemo(() => shapes(profiles), [profiles]);
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
          <label className="btn">Open .jsonl
            <input type="file" accept=".jsonl,.json" multiple hidden
                   onChange={(e) => { if (e.target.files.length) importFiles([...e.target.files]); e.target.value = ""; }} />
          </label>
        </div>
      </header>

      <div className="shell">
        <aside className="rail">
          {sessions.length > 0 && (
            <>
              <h2>Sessions</h2>
              {sessions.map((s) => (
                <div className="sessrow" key={s.id} aria-current={s.id === state.sessionId}>
                  <button className="pick" onClick={() => dispatch({ type: "sessionPicked", sessionId: s.id })}>
                    <div className="nm">{s.name}</div>
                    <div className="mt">{s.profiles.length} profiles · {bytes(s.bytes || 0)} ·{" "}
                      {new Date(s.importedAt).toLocaleDateString()}</div>
                  </button>
                  <button className="x" title="Remove this session" aria-label={`Remove ${s.name}`}
                          onClick={async () => {
                            await dropSession(s.id);
                            dispatch({ type: "removed", sessionId: s.id });
                          }}>×</button>
                </div>
              ))}
              <div className="railfoot">
                <span>{bytes(totalBytes)} stored{storageUnavailable() ? " (this session only)" : ""}</span>
                <button className="link" onClick={async () => {
                  if (!confirm("Remove every imported session from this browser?")) return;
                  await dropAll(); dispatch({ type: "cleared" });
                }}>Clear all</button>
              </div>
            </>
          )}
          {current && (
            <>
              <h2>Queries</h2>
              {overview.map((row) => (
                <div className="shape" key={row.fingerprint}>
                  <div className="fp"><span>{row.fingerprint}</span>
                    <span>{row.runs.length} run{row.runs.length > 1 ? "s" : ""}</span></div>
                  {row.runs.map((p) => (
                    <button className="run" key={p.query_id} aria-pressed={p.query_id === state.queryId}
                            onClick={() => pick(p.query_id)}>
                      <div className="l1">{shapeName(p)}</div>
                      <div className="l2">{ms(p.wall_ms)} wall · {ms(p.cpu_ms)} cpu</div>
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </aside>

        <main>
          {!current ? (
            <div className="blank">
              <h3>Nothing loaded</h3>
              <p>Profiles stay in this browser. Nothing is uploaded, and no request leaves the page.</p>
              <div className="zone">
                <div className="big">Drop a <code>.jsonl</code> session here</div>
                <div className="small">or use <b>Open .jsonl</b> above · several files at once is fine</div>
              </div>
              <pre className="snip">{`from polars_telemetry.export.file import FileExporter

polars_telemetry.install(exporter=FileExporter("profiles/session.jsonl"))`}</pre>
            </div>
          ) : !profile ? (
            <>
              <h2>{current.name}</h2>
              <div style={{ fontSize: 15, fontWeight: 600, margin: "-4px 0 4px" }}>
                {profiles.length} profiles · {overview.length} query shape{overview.length > 1 ? "s" : ""}
              </div>
              <p style={{ color: "var(--ink-2)", fontSize: 12.5, margin: "0 0 14px" }}>
                Ranked by total wall time. Pick a shape to see its plans.
              </p>
              <table className="ovw">
                <thead><tr><th>query shape</th><th>runs</th><th>total wall</th><th>share</th><th>mean cpu</th><th /></tr></thead>
                <tbody>
                  {overview.map((r) => (
                    <tr key={r.fingerprint} onClick={() => pick(r.runs[0].query_id)}>
                      <td><div style={{ fontWeight: 500 }}>{shapeName(r.runs[0])}</div>
                        <div style={{ font: "10.5px ui-monospace,monospace", color: "var(--muted)" }}>{r.fingerprint}</div></td>
                      <td>{r.runs.length}</td><td>{ms(r.wallMs)}</td>
                      <td>{num((r.wallMs / totalWall) * 100, 1)}%</td><td>{ms(r.cpuMs / r.runs.length)}</td>
                      <td style={{ width: 140 }}>
                        <div className="bar" style={{ width: `${(r.wallMs / (overview[0].wallMs || 1)) * 100}%` }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <>
              <div className="qhead">
                <div className="qline">
                  <span className="qname">{shapeName(profile)}</span>
                  <span className="qmeta">{profile.fingerprint} ·{" "}
                    {new Date(profile.started_unix_ns / 1e6).toLocaleTimeString()}</span>
                  {profile.call_site && (
                    <span className="qsite" title={profile.call_site.filepath}>
                      {profile.call_site.filepath.split("/").pop()}:{profile.call_site.lineno}
                      {" in "}{profile.call_site.function}()
                    </span>
                  )}
                  {siblings.length > 0 && (
                    <select className="picker" style={{ marginLeft: "auto" }}
                            value={state.compareId ?? ""}
                            onChange={(e) => dispatch({ type: "comparePicked", queryId: e.target.value || null })}>
                      <option value="">compare with…</option>
                      {siblings.map((q) => (
                        <option value={q.query_id} key={q.query_id}>
                          {new Date(q.started_unix_ns / 1e6).toLocaleTimeString()} · {ms(q.wall_ms)}
                        </option>))}
                    </select>
                  )}
                </div>
                <div className="qstats">
                  <b>{num(profile.wall_ms, 1)} ms</b> wall{delta(profile.wall_ms, compare?.wall_ms)} ·{" "}
                  <b>{num(profile.cpu_ms, 1)} ms</b> cpu{delta(profile.cpu_ms, compare?.cpu_ms)} ·{" "}
                  <b>{profile.plan.physical.length}</b> nodes ·{" "}
                  <b>{num(profile.result_rows ?? 0)}</b> rows out · polars {profile.polars_version}
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

              <div className="plans">
                <PlanPane title="Logical plan"
                          plan={profile.plan.logical} logical
                          selectedId={state.node?.plan === "logical" ? state.node.id : null}
                          onSelect={(id) => dispatch({ type: "nodePicked", node: { plan: "logical", id } })} />
                <PlanPane title="Physical plan" subtitle="fill = CPU · edges = rows"
                          plan={profile.plan.physical} logical={false}
                          selectedId={state.node?.plan === "physical" ? state.node.id : null}
                          onSelect={(id) => dispatch({ type: "nodePicked", node: { plan: "physical", id } })} />
              </div>
            </>
          )}
        </main>

        <aside className="rail right">
          <h2>Node details</h2>
          <NodeDetails node={selectedNode} compareNode={compareNode} />
        </aside>
      </div>
    </>
  );
}
