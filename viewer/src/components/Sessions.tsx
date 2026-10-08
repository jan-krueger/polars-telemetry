import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../model/profile";
import { bytes, num } from "../lib/format";
import { ageGroup, ranBetween, shortWhen } from "../lib/time";
import { recent } from "../state/viewer";
import Tip from "./Tip";

const RECENT = 5;
const lastUsed = (s: Session): number => s.openedAt ?? s.importedAt;
const queries = (s: Session): string => `${num(s.count)} quer${s.count === 1 ? "y" : "ies"}`;

interface SwitcherProps {
  sessions: Session[];
  current: Session | null;
  onPick: (sessionId: string) => void;
  onBrowse: () => void;
  onKeep: (session: Session) => void;
}

export function SessionSwitcher({ sessions, current, onPick, onBrowse, onKeep }: SwitcherProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    addEventListener("pointerdown", away);
    addEventListener("keydown", escape);
    return () => { removeEventListener("pointerdown", away); removeEventListener("keydown", escape); };
  }, [open]);

  const others = recent(sessions).filter((s) => s.id !== current?.id).slice(0, RECENT);
  return (
    <div className="switcher" ref={box}>
      <button className="switch-current" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        <span className="switch-text">
          <span className="switch-name">{current ? current.name : "No session open"}</span>
          {current && (
            <span className="switch-meta">
              {queries(current)} · {current.shared ? "opened from a link, not stored"
                : ranBetween(current.ran) ?? `imported ${new Date(current.importedAt).toLocaleDateString()}`}
            </span>
          )}
        </span>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
      </button>
      {current?.shared && (
        <Tip content="Store this session in this browser">
          <button className="link switch-keep" onClick={() => onKeep(current)}>Keep</button>
        </Tip>
      )}
      {open && (
        <div className="switch-menu" role="menu">
          {others.length > 0 && <div className="switch-label">Recent</div>}
          {others.map((s) => (
            <button key={s.id} role="menuitem" className="switch-item" onClick={() => { setOpen(false); onPick(s.id); }}>
              <span className="switch-name">{s.name}</span>
              <span className="switch-meta">{queries(s)} · {shortWhen(lastUsed(s), Date.now())}</span>
            </button>
          ))}
          <button role="menuitem" className="switch-item switch-all" onClick={() => { setOpen(false); onBrowse(); }}>
            All sessions ({sessions.length}) →
          </button>
        </div>
      )}
    </div>
  );
}

type SortName = "opened" | "imported" | "name" | "size";

const SORTS: Record<SortName, { label: string; key: (s: Session) => number | string; when: (s: Session) => number; grouped: boolean }> = {
  opened: { label: "Last opened", key: (s) => -lastUsed(s), when: lastUsed, grouped: true },
  imported: { label: "Imported", key: (s) => -s.importedAt, when: (s) => s.importedAt, grouped: true },
  name: { label: "Name", key: (s) => s.name.toLowerCase(), when: lastUsed, grouped: false },
  size: { label: "Size", key: (s) => -s.bytes, when: lastUsed, grouped: false },
};

interface PageProps {
  sessions: Session[];
  currentId: string | null;
  storageNote: string;
  onPick: (sessionId: string) => void;
  onClose: () => void;
  onRename: (session: Session, name: string) => void;
  onDownload: (session: Session) => void;
  onRemove: (sessionIds: string[]) => void;
  onKeep: (session: Session) => void;
}

export function SessionsPage({ sessions, currentId, storageNote, onPick, onClose, onRename, onDownload, onRemove, onKeep }: PageProps) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortName>("opened");
  const [chosen, setChosen] = useState(new Set<string>());
  const [confirming, setConfirming] = useState<Session[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const now = Date.now();

  const shown = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const { key } = SORTS[sort];
    return sessions
      .filter((s) => words.every((w) => s.name.toLowerCase().includes(w)))
      .sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
  }, [sessions, search, sort]);

  const groups = useMemo(() => {
    if (!SORTS[sort].grouped) return [[null, shown]] as [string | null, Session[]][];
    const out = new Map<string | null, Session[]>();
    for (const s of shown) {
      const group = ageGroup(SORTS[sort].when(s), now);
      out.set(group, [...(out.get(group) ?? []), s]);
    }
    return [...out];
  }, [shown, sort, now]);

  const total = sessions.reduce((a, s) => a + (s.bytes || 0), 0);
  const picked = sessions.filter((s) => chosen.has(s.id));
  const toggle = (id: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const remove = (targets: Session[]) => {
    setConfirming(null);
    setChosen(new Set());
    onRemove(targets.map((s) => s.id));
  };

  return (
    <section className="sp" aria-label="All sessions">
      <div className="sp-head">
        <h3>Sessions</h3>
        <span className="sp-total">{sessions.length} · {bytes(total)} stored{storageNote}</span>
        <input id="session-search" className="search sp-search" type="search" value={search}
               placeholder="Search sessions" aria-label="Search sessions by name"
               onChange={(e) => setSearch(e.target.value)} />
        <select id="session-sort" className="picker" value={sort} aria-label="Sort sessions"
                onChange={(e) => setSort(e.target.value as SortName)}>
          {Object.entries(SORTS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
        </select>
        <button className="btn" onClick={onClose}>Back</button>
      </div>

      {!shown.length && <p className="sp-empty">No session matches “{search}”.</p>}
      <table className="sp-table">
        {groups.map(([group, rows]) => (
          <tbody key={group ?? "all"}>
            {group && <tr><th colSpan={6} className="sp-group">{group}</th></tr>}
            {rows.map((s) => (
              <tr key={s.id} aria-current={s.id === currentId} className="sp-row">
                <td className="sp-check">
                  <input id={`choose-${s.id}`} type="checkbox" checked={chosen.has(s.id)}
                         aria-label={`Select ${s.name}`} onChange={() => toggle(s.id)} />
                </td>
                <td className="sp-name">
                  {renaming === s.id ? (
                    <input className="rename" id={`rename-${s.id}`} aria-label={`New name for ${s.name}`}
                           defaultValue={s.name} autoFocus onFocus={(e) => e.target.select()}
                           onBlur={(e) => { setRenaming(null); if (!e.target.dataset.cancel) onRename(s, e.target.value); }}
                           onKeyDown={(e) => {
                             if (e.key === "Escape") e.currentTarget.dataset.cancel = "1";
                             if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                           }} />
                  ) : (
                    <Tip content="Open it; double-click to rename">
                      <button className="sp-open" onClick={() => onPick(s.id)} onDoubleClick={() => setRenaming(s.id)}
                              onKeyDown={(e) => { if (e.key === "F2") setRenaming(s.id); }}>{s.name}</button>
                    </Tip>
                  )}
                  {s.shared && <span className="sp-note">from a link, not stored · <button className="link" onClick={() => onKeep(s)}>Keep</button></span>}
                </td>
                <td className="sp-num">{queries(s)}</td>
                <td className="sp-num">{bytes(s.bytes || 0)}</td>
                <td className="sp-num">{shortWhen(SORTS[sort].when(s), now)}</td>
                <td className="sp-actions">
                  <Tip content="Download this session">
                    <button className="x x-dl" aria-label={`Download ${s.name}`} onClick={() => onDownload(s)}>
                      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none"
                           stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
                      </svg>
                    </button>
                  </Tip>
                  <Tip content="Remove this session">
                    <button className="x" aria-label={`Remove ${s.name}`} onClick={() => remove([s])}>×</button>
                  </Tip>
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>

      <div className="sp-foot" role={confirming ? "alert" : undefined}>
        {confirming ? (
          <>
            <span>Remove {confirming.length === sessions.length ? "all " : ""}{confirming.length} session{confirming.length > 1 ? "s" : ""}?</span>
            <button className="link link--crit" onClick={() => remove(confirming)}>Remove</button>
            <button className="link" onClick={() => setConfirming(null)}>Keep</button>
          </>
        ) : picked.length ? (
          <>
            <span>{picked.length} selected · {bytes(picked.reduce((a, s) => a + (s.bytes || 0), 0))}</span>
            <button className="link link--crit" onClick={() => setConfirming(picked)}>Remove selected</button>
            <button className="link" onClick={() => setChosen(new Set())}>Clear selection</button>
          </>
        ) : (
          <button className="link" onClick={() => setConfirming(sessions)}>Remove all sessions</button>
        )}
      </div>
    </section>
  );
}
