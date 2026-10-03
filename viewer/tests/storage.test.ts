import { beforeEach, expect, it, vi } from "vitest";

const stored = new Map<string, { id: string; huge?: boolean }>();
let opened = 0;

function fakeIndexedDb() {
  return {
    open() {
      opened++;
      const request: Record<string, unknown> & { onsuccess?: () => void } = {};
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const transaction: Record<string, unknown> & { onabort?: () => void; oncomplete?: () => void } = {};
            let quota = false;
            transaction.objectStore = () => ({
              put(session: { id: string; huge?: boolean }) {
                if (session.huge) quota = true;
                else stored.set(session.id, session);
                return {};
              },
              delete(id: string) { stored.delete(id); return {}; },
              getAll() { return { result: [...stored.values()] }; },
              clear() { stored.clear(); return {}; },
            });
            setTimeout(() => {
              if (quota) {
                transaction.error = new Error("QuotaExceededError");
                transaction.onabort?.();
              } else transaction.oncomplete?.();
            });
            return transaction;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
}

beforeEach(() => {
  stored.clear();
  opened = 0;
  vi.resetModules();
  vi.stubGlobal("indexedDB", fakeIndexedDb());
});

it("a failed save is reported, and later removals still reach the store", async () => {
  const storage = await import("../src/lib/storage.js");
  await storage.saveSession({ id: "old" });
  await expect(storage.saveSession({ id: "big", huge: true })).rejects.toThrow("Quota");
  expect(storage.storageUnavailable()).toBe(false);

  await storage.dropSession("old");
  expect(stored.has("old")).toBe(false);
});

it("opens one connection for every operation", async () => {
  const storage = await import("../src/lib/storage.js");
  await storage.saveSession({ id: "a" });
  await storage.dropSession("a");
  await storage.allSessions();
  expect(opened).toBe(1);
});
