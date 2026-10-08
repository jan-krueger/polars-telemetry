// Sessions live in IndexedDB so an imported file survives a reload. Opening
// can hang outright (file:// origins, blocked site data), so every call is
// time-boxed and failure degrades to in-memory rather than wedging the page.
// A slow open is not a failed one: Firefox can take seconds after a browser
// start, so the open carries on and `storageOpened` says when it is done.
//
// The session list and the profiles are separate stores: the list is read on
// every load, a session's profiles only when it is opened.
import type { SessionInfo } from "../model/profile";
import { readProfiles, sessionInfo } from "../model/read";

const DB_NAME = "polars-telemetry-viewer";
const VERSION = 2;
const LIST = "sessions";
const PROFILES = "profiles";
const OPEN_TIMEOUT_MS = 1500;

let status: "opening" | "open" | "failed" = "opening";
/** True until storage has opened: while it is still opening, and for good once it failed. */
export const storageUnavailable = () => status !== "open";

let connection: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, VERSION); } catch (e) { reject(e); return; }
    req.onupgradeneeded = (event) => upgrade(req.result, req.transaction!, event.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("indexedDB blocked"));
  }).then(
    (db) => { status = "open"; return db; },
    (error) => { status = "failed"; throw error; },
  );
  return connection;
}

const timedOut = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), OPEN_TIMEOUT_MS));

/** Resolves true once storage opens, however late, or false when it cannot. */
export const storageOpened = () => openDb().then(() => true, () => false);

/** Version 1 kept each session's profiles in its list entry; move them out. */
function upgrade(db: IDBDatabase, transaction: IDBTransaction, from: number): void {
  if (!db.objectStoreNames.contains(LIST)) db.createObjectStore(LIST, { keyPath: "id" });
  if (!db.objectStoreNames.contains(PROFILES)) db.createObjectStore(PROFILES, { keyPath: "id" });
  if (from !== 1) return;
  const profiles = transaction.objectStore(PROFILES);
  transaction.objectStore(LIST).openCursor().onsuccess = (e) => {
    const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (!cursor) return;
    const { profiles: raw = [], ...rest } = cursor.value;
    profiles.put({ id: rest.id, raw });
    cursor.update(sessionInfo(rest, readProfiles(raw)));
    cursor.continue();
  };
}

/** The request's result, or null when storage cannot be opened at all. A
 *  failing transaction rejects, and leaves storage usable for the next one. */
async function tx<T>(stores: string[], mode: IDBTransactionMode,
                   fn: (store: (name: string) => IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  if (status === "failed") return null;
  let db: IDBDatabase | null;
  try {
    db = await Promise.race([openDb(), timedOut()]);
  } catch {
    return null;
  }
  if (!db) return null;
  return new Promise<T | null>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const r = fn((name) => t.objectStore(name));
    t.oncomplete = () => resolve(r?.result ?? null);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const both = [LIST, PROFILES];

/** Store a session: its list entry and its documents, together or not at all. */
export const saveSession = (info: SessionInfo, raw: unknown[]) =>
  tx(both, "readwrite", (store) => { store(PROFILES).put({ id: info.id, raw }); return store(LIST).put(info); });
/** Update a session's list entry only: a rename, when it was opened. */
export const saveInfo = (info: SessionInfo) => tx([LIST], "readwrite", (store) => store(LIST).put(info));
export const listSessions = (): Promise<SessionInfo[] | null> =>
  tx([LIST], "readonly", (store) => store(LIST).getAll()).catch(() => null);
/** A session's documents as written, or null if they are not stored. */
export const loadDocuments = async (id: string): Promise<unknown[] | null> =>
  ((await tx([PROFILES], "readonly", (store) => store(PROFILES).get(id))) as { raw?: unknown[] } | null)?.raw ?? null;
export const dropSession = (id: string) =>
  tx(both, "readwrite", (store) => { store(PROFILES).delete(id); return store(LIST).delete(id); });
export const dropAll = () => tx(both, "readwrite", (store) => { store(PROFILES).clear(); return store(LIST).clear(); });
