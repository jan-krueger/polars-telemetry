// Sessions live in IndexedDB so an imported file survives a reload. Opening
// can hang outright (file:// origins, blocked site data), so every call is
// time-boxed and failure degrades to in-memory rather than wedging the page.
const DB_NAME = "polars-telemetry-viewer";
const STORE = "sessions";
const OPEN_TIMEOUT_MS = 1500;

let unavailable = false;
export const storageUnavailable = () => unavailable;

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => reject(new Error("indexedDB open timed out")), OPEN_TIMEOUT_MS);
    const settle = (fn, v) => { clearTimeout(timer); fn(v); };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => settle(resolve, req.result);
    req.onerror = () => settle(reject, req.error);
    req.onblocked = () => settle(reject, new Error("indexedDB blocked"));
  });
}

async function tx(mode, fn) {
  if (unavailable) return null;
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r?.result ?? null);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch {
    unavailable = true;
    return null;
  }
}

export const saveSession = (s) => tx("readwrite", (st) => st.put(s));
export const allSessions = () => tx("readonly", (st) => st.getAll());
export const dropSession = (id) => tx("readwrite", (st) => st.delete(id));
export const dropAll = () => tx("readwrite", (st) => st.clear());
