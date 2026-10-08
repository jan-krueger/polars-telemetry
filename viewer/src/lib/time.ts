// `zone` is for tests; otherwise the reader's timezone.

import type { Profile } from "../model/profile";

// Rounded: ns counts exceed float precision.
const toDate = (ns: number): Date => new Date(Math.round(ns / 1e6));

export const iso = (ns: number): string => toDate(ns).toISOString();

const recorded = (profiles: Profile[]): number[] =>
  profiles.map((p) => p.started_unix_ns).filter((ns) => ns > 0);

const day = (ns: number, zone?: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short" }).format(toDate(ns));

export function spansDays(profiles: Profile[], zone?: string): boolean {
  return new Set(recorded(profiles).map((ns) => day(ns, zone))).size > 1;
}

export function clock(ns: number, withDate: boolean, zone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    timeStyle: "medium",
    ...(withDate ? { dateStyle: "medium" } : {}),
  }).format(toDate(ns));
}

export function instant(ns: number, zone?: string): string {
  const shownIn = new Intl.DateTimeFormat(undefined, { timeZone: zone }).resolvedOptions().timeZone;
  return `${iso(ns)} · shown in ${shownIn}`;
}

export function ranOf(starts: number[]): [number, number] | null {
  const times = starts.filter((ns) => ns > 0);
  if (!times.length) return null;
  // Math.min(...times) overflows the stack on large sessions.
  return [times.reduce((a, b) => Math.min(a, b)), times.reduce((a, b) => Math.max(a, b))];
}

export function ranBetween(ran: [number, number] | null, zone?: string): string | null {
  if (!ran) return null;
  const format = new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: "medium", timeStyle: "short" });
  return format.formatRange(toDate(ran[0]), toDate(ran[1]));
}

const midnight = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);

export function ageGroup(ms: number, now: number): "Today" | "Yesterday" | "This week" | "Older" {
  const days = Math.round((midnight(now) - midnight(ms)) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "This week" : "Older";
}

/** The time today, else the date. */
export function shortWhen(ms: number, now: number, zone?: string): string {
  const today = ageGroup(ms, now) === "Today";
  return new Intl.DateTimeFormat(undefined, today
    ? { timeZone: zone, timeStyle: "short" }
    : { timeZone: zone, dateStyle: "medium" }).format(new Date(ms));
}
