import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { Session, SessionInfo } from "../model/profile";
import { readJsonl, readProfiles, sessionInfo, toJsonl } from "../model/read";
import { dropSession, listSessions, loadDocuments, saveInfo, saveSession, storageOpened, storageUnavailable } from "../lib/storage";
import { isShareFragment, openShareFragment } from "../share/link";
import { sharedSession } from "../share/session";
import { fromHash } from "../state/route";
import { currentSession, sameRuns, type Action, type ViewerState } from "../state/viewer";

export interface Example {
  file: string;
  title: string;
}

export interface SessionActions {
  /** What did not work, one line each; shown until dismissed or the next import. */
  problems: string[];
  report: (problems: string[]) => void;
  importFiles: (files: File[]) => Promise<void>;
  remove: (sessionIds: string[]) => Promise<void>;
  save: (session: Session) => Promise<void>;
  rename: (session: Session, typed: string) => Promise<void>;
  keep: (session: Session) => Promise<void>;
  loadExample: (example: Example) => Promise<void>;
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const unread = (info: SessionInfo): Session => ({ ...info, profiles: null, raw: null });

/** Sessions as this browser stores them: listed on boot, read when opened, and every change written back. */
export default function useSessions(state: ViewerState, dispatch: Dispatch<Action>): SessionActions {
  const { booted, sessions } = state;
  const [problems, report] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      // Stored raw and read on every load, so a newer reader improves old sessions.
      const listed = (await listSessions()) || [];
      dispatch({ type: "loaded", sessions: listed.map(unread) });
      if (storageUnavailable()) {
        storageOpened().then(async (opened) => {
          if (!opened) return;
          const late = (await listSessions()) || [];
          dispatch({ type: "stored", sessions: late.map(unread) });
          if (!isShareFragment(location.hash)) dispatch({ type: "navigated", route: fromHash(location.hash) });
        });
      }
      if (!isShareFragment(location.hash)) {
        dispatch({ type: "navigated", route: fromHash(location.hash) });
        return;
      }
      const opened = openShareFragment(location.hash);
      if ("problem" in opened) {
        report([`Shared link: ${opened.problem}.`]);
        history.replaceState(null, "", location.pathname + location.search);
        return;
      }
      const shared = sharedSession(location.hash, opened.documents, Date.now());
      dispatch({ type: "imported", sessions: [shared] });
      if (shared.profiles?.[0]) dispatch({ type: "queryPicked", queryId: shared.profiles[0].query_id });
      if (shared.profiles?.[1]) dispatch({ type: "comparePicked", queryId: shared.profiles[1].query_id });
    })();
  }, [dispatch]);

  const current = currentSession(state);
  const reading = useRef<string | null>(null);
  useEffect(() => {
    if (!booted || !current || current.profiles || reading.current === current.id) return;
    const { id, name } = current;
    reading.current = id;
    (async () => {
      const raw = await loadDocuments(id).catch(() => null);
      reading.current = null;
      if (!raw) {
        report([`${name}: its profiles could not be read from this browser's storage.`]);
        return;
      }
      dispatch({ type: "read", sessionId: id, profiles: readProfiles(raw), raw, forgetOthers: !storageUnavailable() });
    })();
  }, [booted, current, dispatch]);

  useEffect(() => {
    if (!booted || !current) return;
    const at = Date.now();
    dispatch({ type: "opened", sessionId: current.id, at });
    if (!current.shared) saveInfo(infoOf({ ...current, openedAt: at })).catch(() => {});
  }, [booted, current?.id]);

  const open = useRef(sessions);
  open.current = sessions;
  const importFiles = useCallback(async (files: File[]) => {
    const added: Session[] = [];
    const rejected: string[] = [];
    let reopened: string | null = null;
    for (const f of files) {
      let read: ReturnType<typeof readJsonl>;
      try {
        read = readJsonl(await f.text());
      } catch (e) {
        rejected.push(`${f.name}: ${reason(e)}`);
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
        rejected.push(`${f.name}: open for this page only, not stored (${reason(e)})`);
      }
      added.push({ ...info, profiles: read.profiles, raw: read.raw });
    }
    report(rejected);
    if (added.length) dispatch({ type: "imported", sessions: added });
    else if (reopened) dispatch({ type: "sessionPicked", sessionId: reopened });
  }, [dispatch]);

  useFileDrop(importFiles);

  const remove = async (sessionIds: string[]) => {
    const failed: string[] = [];
    for (const id of sessionIds) {
      try {
        await dropSession(id);
      } catch (e) {
        failed.push(`${sessions.find((s) => s.id === id)?.name ?? id}: removed from this page, but still stored (${reason(e)})`);
      }
    }
    if (failed.length) report(failed);
    dispatch({ type: "removed", sessionIds });
  };

  const save = async (session: Session) => {
    const raw = session.raw ?? (await loadDocuments(session.id).catch(() => null));
    if (raw) download(session.name, raw);
    else report([`${session.name}: its profiles could not be read from this browser's storage.`]);
  };

  const rename = async (session: Session, typed: string) => {
    const name = typed.trim();
    if (!name || name === session.name) return;
    dispatch({ type: "renamed", sessionId: session.id, name });
    if (session.shared || storageUnavailable()) return;
    try {
      await saveInfo(infoOf({ ...session, name }));
    } catch (e) {
      report([`${name}: renamed on this page only, not stored (${reason(e)})`]);
    }
  };

  const keep = async (session: Session) => {
    if (!session.raw) return;
    try {
      await saveSession(infoOf(session), session.raw);
      dispatch({ type: "kept", sessionId: session.id });
    } catch (e) {
      report([`${session.name}: could not be stored (${reason(e)})`]);
    }
  };

  // Served beside the hosted viewer; opened from disk there is nothing to fetch.
  const loadExample = async ({ file }: Example) => {
    try {
      const response = await fetch(`examples/${file}`);
      if (!response.ok) throw new Error(`${response.status}`);
      await importFiles([new File([await response.blob()], file)]);
    } catch {
      report([`${file}: examples load only on the hosted viewer. Download it from `
        + "github.com/jan-krueger/polars-telemetry/tree/main/examples and open it here."]);
    }
  };

  return { problems, report, importFiles, remove, save, rename, keep, loadExample };
}

/** Files dropped anywhere on the page are imported. */
function useFileDrop(importFiles: (files: File[]) => void): void {
  useEffect(() => {
    const over = (e: DragEvent) => { e.preventDefault(); document.body.classList.add("dragging"); };
    const leave = (e: DragEvent) => { if (e.relatedTarget === null) document.body.classList.remove("dragging"); };
    const drop = (e: DragEvent) => {
      e.preventDefault(); document.body.classList.remove("dragging");
      if (e.dataTransfer?.files.length) importFiles([...e.dataTransfer.files]);
    };
    addEventListener("dragover", over); addEventListener("dragleave", leave); addEventListener("drop", drop);
    return () => { removeEventListener("dragover", over); removeEventListener("dragleave", leave);
                   removeEventListener("drop", drop); };
  }, [importFiles]);
}

/** Save a session as the .jsonl it was imported from. */
function download(name: string, raw: unknown[]): void {
  const url = URL.createObjectURL(new Blob([toJsonl(raw)], { type: "application/jsonl" }));
  const link = Object.assign(document.createElement("a"), {
    href: url, download: name.endsWith(".jsonl") ? name : `${name}.jsonl`,
  });
  link.click();
  URL.revokeObjectURL(url);
}

/** A session's list entry, as storage keeps it. */
function infoOf({ id, name, importedAt, openedAt, bytes, count, runIds, ran }: SessionInfo): SessionInfo {
  return { id, name, importedAt, openedAt, bytes, count, runIds, ran };
}
