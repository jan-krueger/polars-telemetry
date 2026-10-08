import { afterEach, expect, it, vi } from "vitest";
import { stopWarningUnmasked, warnsUnmasked } from "../src/lib/prefs";

afterEach(() => vi.unstubAllGlobals());

it("warns until told to stop, and keeps warning when storage is blocked", () => {
  const kept = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v) });
  expect(warnsUnmasked()).toBe(true);
  stopWarningUnmasked();
  expect(warnsUnmasked()).toBe(false);

  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(() => stopWarningUnmasked()).not.toThrow();
  expect(warnsUnmasked()).toBe(true);
});
