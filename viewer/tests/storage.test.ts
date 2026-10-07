import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/profile.json", import.meta.url), "utf8"));

type Row = { id: string; huge?: boolean; [key: string]: unknown };
let stores: Map<string, Map<string, Row>>;
let version: number;
let opened: number;
let openDelayMs: number;
let openFails: boolean;

const later = (fn: () => void) => setTimeout(fn);

function objectStore(name: string, fail: () => void) {
  const rows = stores.get(name)!;
  return {
    put(row: Row) {
      if (row.huge) fail();
      else rows.set(row.id, row);
      return {};
    },
    get(id: string) { return { result: rows.get(id) }; },
    delete(id: string) { rows.delete(id); return {}; },
    getAll() { return { result: [...rows.values()] }; },
    clear() { rows.clear(); return {}; },
    openCursor() {
      const request: { onsuccess?: (e: unknown) => void } = {};
      const keys = [...rows.keys()];
      const step = (i: number) => later(() => {
        const key = keys[i];
        const cursor = key === undefined ? null : {
          value: rows.get(key),
          update(row: Row) { rows.set(key, row); },
          continue() { step(i + 1); },
        };
        request.onsuccess?.({ target: { result: cursor } });
      });
      step(0);
      return request;
    },
  };
}

function fakeIndexedDb() {
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) { stores.set(name, new Map()); },
    transaction() {
      const transaction: Record<string, unknown> & { onabort?: () => void; oncomplete?: () => void } = {};
      let quota = false;
      transaction.objectStore = (name: string) => objectStore(name, () => { quota = true; });
      later(() => {
        if (quota) {
          transaction.error = new Error("QuotaExceededError");
          transaction.onabort?.();
        } else transaction.oncomplete?.();
      });
      return transaction;
    },
  };
  return {
    open(_name: string, wanted: number) {
      opened++;
      const request: Record<string, unknown> & {
        onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: (e: { oldVersion: number }) => void;
      } = { result: db };
      if (openFails) {
        later(() => { request.error = new Error("denied"); request.onerror?.(); });
        return request;
      }
      setTimeout(() => {
        if (version < wanted) {
          request.transaction = { objectStore: (name: string) => objectStore(name, () => {}) };
          request.onupgradeneeded?.({ oldVersion: version });
          version = wanted;
        }
        later(() => later(() => later(() => request.onsuccess?.())));
      }, openDelayMs);
      return request;
    },
  };
}

beforeEach(() => {
  stores = new Map();
  version = 0;
  opened = 0;
  openDelayMs = 0;
  openFails = false;
  vi.resetModules();
  vi.stubGlobal("indexedDB", fakeIndexedDb());
});

const info = (id: string, extra: object = {}) => ({ id, name: `${id}.jsonl`, ...extra });

it("a failed save is reported, and later removals still reach the store", async () => {
  const storage = await import("../src/lib/storage.js");
  await storage.saveSession(info("old"), []);
  await expect(storage.saveSession(info("big", { huge: true }), [])).rejects.toThrow("Quota");
  expect(storage.storageUnavailable()).toBe(false);

  await storage.dropSession("old");
  expect(stores.get("sessions")!.has("old")).toBe(false);
  expect(stores.get("profiles")!.has("old")).toBe(false);
});

it("opens one connection for every operation", async () => {
  const storage = await import("../src/lib/storage.js");
  await storage.saveSession(info("a"), []);
  await storage.dropSession("a");
  await storage.listSessions();
  expect(opened).toBe(1);
});

it("lists sessions without their documents, and reads those on request", async () => {
  const storage = await import("../src/lib/storage.js");
  await storage.saveSession(info("a"), [fixture]);
  expect(await storage.listSessions()).toEqual([info("a")]);
  expect(await storage.loadDocuments("a")).toEqual([fixture]);
  expect(await storage.loadDocuments("missing")).toBeNull();
});

it("moves version 1 sessions' documents out of the list, once", async () => {
  stores.set("sessions", new Map([["old", { id: "old", name: "old.jsonl", importedAt: 7, bytes: 9, profiles: [fixture] }]]));
  version = 1;
  const storage = await import("../src/lib/storage.js");

  const [entry] = (await storage.listSessions()) as Row[];
  expect(entry).toMatchObject({ id: "old", name: "old.jsonl", importedAt: 7, bytes: 9, count: 1, openedAt: null });
  expect(entry!.runIds).toEqual([fixture.query_id]);
  expect(entry).not.toHaveProperty("profiles");
  expect(await storage.loadDocuments("old")).toEqual([fixture]);
});

it("a slow open is not a failed one: it lists the sessions once storage answers", async () => {
  stores.set("sessions", new Map([["a", { id: "a", name: "a.jsonl" }]]));
  stores.set("profiles", new Map());
  version = 2;
  openDelayMs = 2_000;
  const storage = await import("../src/lib/storage.js");

  expect(await storage.listSessions()).toBeNull();
  expect(storage.storageUnavailable()).toBe(true);
  expect(await storage.storageOpened()).toBe(true);
  expect(storage.storageUnavailable()).toBe(false);
  expect(await storage.listSessions()).toEqual([{ id: "a", name: "a.jsonl" }]);
  expect(opened).toBe(1);
});

it("a failed open stays failed", async () => {
  openFails = true;
  const storage = await import("../src/lib/storage.js");
  expect(await storage.listSessions()).toBeNull();
  expect(await storage.storageOpened()).toBe(false);
  expect(storage.storageUnavailable()).toBe(true);
});
