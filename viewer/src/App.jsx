import { useCallback, useEffect, useMemo, useState } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import PlanPane from "./components/PlanPane";
import NodeDetails from "./components/NodeDetails";
import Help from "./components/Help";
import { allSessions, dropAll, dropSession, saveSession, storageUnavailable } from "./lib/storage";
import { bytes, diagnostics, ms, num, parseJsonl, shapeName } from "./lib/format";

const VERDICT = { good: "var(--good)", warn: "var(--warn)", crit: "var(--crit)", info: "var(--muted)" };
const hottest = (p) => {
  const h = p.plan.physical.filter((n) => n.metrics)
    .sort((a, b) => b.metrics.total_time_ns - a.metrics.total_time_ns)[0];
  return h ? { plan: "physical", id: h.id } : null;
};

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [sel, setSel] = useState(null);
  const [selNode, setSelNode] = useState(null);
  const [compareWith, setCompareWith] = useState(null);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    (async () => {
      const stored = (await allSessions()) || [];
      stored.sort((a, b) => b.importedAt - a.importedAt);
      setSessions(stored);
      if (stored.length) setCurrentId(stored[0].id);
      setBooted(true);
    })();
  }, []);

  const current = sessions.find((s) => s.id === currentId) || null;
  const profiles = current?.profiles ?? [];
  const profile = sel != null ? profiles[sel] : null;
  const compare = compareWith != null ? profiles[compareWith] : null;

  const importFiles = useCallback(async (files) => {
    const added = [];
    for (const f of files) {
      const parsed = parseJsonl(await f.text());
      if (!parsed.length) continue;
      const s = { id: crypto.randomUUID(), name: f.name, importedAt: Date.now(),
                  bytes: f.size, profiles: parsed };
      await saveSession(s);
      added.push(s);
    }
    if (!added.length) { alert("No polars-telemetry profiles found."); return; }
    setSessions((prev) => [...added, ...prev]);
    setCurrentId(added[0].id); setSel(null); setSelNode(null); setCompareWith(null);
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

  const pick = (i) => { setSel(i); setSelNode(hottest(profiles[i])); setCompareWith(null); };

  const overview = useMemo(() => {
    const g = {};
    for (const p of profiles) {
      const row = (g[p.fingerprint] ??= { fp: p.fingerprint, name: shapeName(p), runs: 0, wall: 0, cpu: 0 });
      row.runs++; row.wall += p.wall_ms; row.cpu += p.cpu_ms;
    }
    return Object.values(g).sort((a, b) => b.wall - a.wall);
  }, [profiles]);

  const selectedNode = profile && selNode
    ? profile.plan[selNode.plan]?.find((n) => n.id === selNode.id) : null;
  const compareNode = compare && selNode
    ? compare.plan[selNode.plan]?.find((n) => n.id === selNode.id) : null;

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
                <div className="sessrow" key={s.id} aria-current={s.id === currentId}>
                  <button className="pick" onClick={() => { setCurrentId(s.id); setSel(null); setSelNode(null); }}>
                    <div className="nm">{s.name}</div>
                    <div className="mt">{s.profiles.length} profiles · {bytes(s.bytes || 0)} ·{" "}
                      {new Date(s.importedAt).toLocaleDateString()}</div>
                  </button>
                  <button className="x" title="Remove this session" aria-label={`Remove ${s.name}`}
                          onClick={async () => {
                            await dropSession(s.id);
                            setSessions((p) => p.filter((x) => x.id !== s.id));
                            if (currentId === s.id) { setCurrentId(null); setSel(null); }
                          }}>×</button>
                </div>
              ))}
              <div className="railfoot">
                <span>{bytes(totalBytes)} stored{storageUnavailable() ? " (this session only)" : ""}</span>
                <button className="link" onClick={async () => {
                  if (!confirm("Remove every imported session from this browser?")) return;
                  await dropAll(); setSessions([]); setCurrentId(null); setSel(null);
                }}>Clear all</button>
              </div>
            </>
          )}
          {current && (
            <>
              <h2>Queries</h2>
              {overview.map((row) => (
                <div className="shape" key={row.fp}>
                  <div className="fp"><span>{row.fp}</span><span>{row.runs} run{row.runs > 1 ? "s" : ""}</span></div>
                  {profiles.map((p, i) => p.fingerprint !== row.fp ? null : (
                    <button className="run" key={p.query_id} aria-pressed={i === sel} onClick={() => pick(i)}>
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
                  {overview.map((r) => {
                    const total = overview.reduce((a, x) => a + x.wall, 0) || 1;
                    return (
                      <tr key={r.fp} onClick={() => pick(profiles.findIndex((p) => p.fingerprint === r.fp))}>
                        <td><div style={{ fontWeight: 500 }}>{r.name}</div>
                          <div style={{ font: "10.5px ui-monospace,monospace", color: "var(--muted)" }}>{r.fp}</div></td>
                        <td>{r.runs}</td><td>{ms(r.wall)}</td>
                        <td>{num((r.wall / total) * 100, 1)}%</td><td>{ms(r.cpu / r.runs)}</td>
                        <td style={{ width: 140 }}>
                          <div className="bar" style={{ width: `${(r.wall / overview[0].wall) * 100}%` }} /></td>
                      </tr>
                    );
                  })}
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
                  {profiles.some((q, i) => q.fingerprint === profile.fingerprint && i !== sel) && (
                    <select className="sel" style={{ marginLeft: "auto" }}
                            value={compareWith ?? ""}
                            onChange={(e) => setCompareWith(e.target.value === "" ? null : Number(e.target.value))}>
                      <option value="">compare with…</option>
                      {profiles.map((q, i) => q.fingerprint === profile.fingerprint && i !== sel ? (
                        <option value={i} key={q.query_id}>
                          {new Date(q.started_unix_ns / 1e6).toLocaleTimeString()} · {ms(q.wall_ms)}
                        </option>) : null)}
                    </select>
                  )}
                </div>
                <div className="qstats">
                  <b>{num(profile.wall_ms, 1)} ms</b> wall{delta(profile.wall_ms, compare?.wall_ms)} ·{" "}
                  <b>{num(profile.cpu_ms, 1)} ms</b> cpu{delta(profile.cpu_ms, compare?.cpu_ms)} ·{" "}
                  <b>{profile.plan.physical.length}</b> nodes ·{" "}
                  <b>{num(profile.result_rows ?? 0)}</b> rows out · polars {profile.polars_version}
                </div>
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
                          selectedId={selNode?.plan === "logical" ? selNode.id : null}
                          onSelect={(id) => setSelNode({ plan: "logical", id })} />
                <PlanPane title="Physical plan" subtitle="fill = CPU · edges = rows"
                          plan={profile.plan.physical} logical={false}
                          selectedId={selNode?.plan === "physical" ? selNode.id : null}
                          onSelect={(id) => setSelNode({ plan: "physical", id })} />
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
