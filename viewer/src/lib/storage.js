// Sessions live in IndexedDB so an imported file survives a reload. Opening
// can hang outright (file:// origins, blocked site data), so every call is
// time-boxed and failure degrades to in-memory rather than wedging the page.
//
// The session list and the profiles are separate stores: the list is read on
// every load, a session's profiles only when it is opened.
import { readProfiles, sessionInfo } from "../model/read";

const DB_NAME = "polars-telemetry-viewer";
const VERSION = 2;
const LIST = "sessions";
const PROFILES = "profiles";
const OPEN_TIMEOUT_MS = 1500;

let unavailable = false;
export const storageUnavailable = () => unavailable;

let connection = null;

function openDb() {
  connection ??= new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, VERSION); } catch (e) { reject(e); return; }
    let timer = setTimeout(() => reject(new Error("indexedDB open timed out")), OPEN_TIMEOUT_MS);
    const settle = (fn, v) => { clearTimeout(timer); fn(v); };
    req.onupgradeneeded = (event) => {
      // Storage answered; a migration may take longer than the open timeout.
      clearTimeout(timer);
      timer = null;
      upgrade(req.result, req.transaction, event.oldVersion);
    };
    req.onsuccess = () => settle(resolve, req.result);
    req.onerror = () => settle(reject, req.error);
    req.onblocked = () => settle(reject, new Error("indexedDB blocked"));
  });
  return connection;
}

/** Version 1 kept each session's profiles in its list entry; move them out. */
function upgrade(db, transaction, from) {
  if (!db.objectStoreNames.contains(LIST)) db.createObjectStore(LIST, { keyPath: "id" });
  if (!db.objectStoreNames.contains(PROFILES)) db.createObjectStore(PROFILES, { keyPath: "id" });
  if (from !== 1) return;
  const profiles = transaction.objectStore(PROFILES);
  transaction.objectStore(LIST).openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    const { profiles: raw = [], ...rest } = cursor.value;
    profiles.put({ id: rest.id, raw });
    cursor.update(sessionInfo(rest, readProfiles(raw)));
    cursor.continue();
  };
}

/** The request's result, or null when storage cannot be opened at all. A
 *  failing transaction rejects, and leaves storage usable for the next one. */
async function tx(stores, mode, fn) {
  if (unavailable) return null;
  let db;
  try {
    db = await openDb();
  } catch {
    unavailable = true;
    return null;
  }
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const r = fn((name) => t.objectStore(name));
    t.oncomplete = () => resolve(r?.result ?? null);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const both = [LIST, PROFILES];

/** Store a session: its list entry and its documents, together or not at all. */
export const saveSession = (info, raw) =>
  tx(both, "readwrite", (store) => { store(PROFILES).put({ id: info.id, raw }); return store(LIST).put(info); });
/** Update a session's list entry only: a rename, when it was opened. */
export const saveInfo = (info) => tx([LIST], "readwrite", (store) => store(LIST).put(info));
export const listSessions = () => tx([LIST], "readonly", (store) => store(LIST).getAll()).catch(() => null);
/** A session's documents as written, or null if they are not stored. */
export const loadDocuments = async (id) =>
  (await tx([PROFILES], "readonly", (store) => store(PROFILES).get(id)))?.raw ?? null;
export const dropSession = (id) =>
  tx(both, "readwrite", (store) => { store(PROFILES).delete(id); return store(LIST).delete(id); });
export const dropAll = () => tx(both, "readwrite", (store) => { store(PROFILES).clear(); return store(LIST).clear(); });
