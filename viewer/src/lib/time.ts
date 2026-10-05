/**
 * When queries ran, shown in the browser's timezone and locale.
 *
 * Profiles record a Unix timestamp from the machine that ran the query; the
 * zone is the reader's. `zone` exists for tests and is otherwise left unset.
 */

import type { Profile } from "../model/profile";

// Rounded: a nanosecond count is past float precision, so a plain division
// can land a millisecond short.
const toDate = (ns: number): Date => new Date(Math.round(ns / 1e6));

/** The instant as ISO 8601 UTC, for a <time> element. */
export const iso = (ns: number): string => toDate(ns).toISOString();

/** Start times of the queries that recorded one. */
const recorded = (profiles: Profile[]): number[] =>
  profiles.map((p) => p.started_unix_ns).filter((ns) => ns > 0);

const day = (ns: number, zone?: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short" }).format(toDate(ns));

/** Whether the queries ran on more than one local day, so times need a date. */
export function spansDays(profiles: Profile[], zone?: string): boolean {
  return new Set(recorded(profiles).map((ns) => day(ns, zone))).size > 1;
}

/** A start time, with its date when the times around it need one. */
export function clock(ns: number, withDate: boolean, zone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    timeStyle: "medium",
    ...(withDate ? { dateStyle: "medium" } : {}),
  }).format(toDate(ns));
}

/** The exact instant, in UTC, and the zone the clock time is shown in. */
export function instant(ns: number, zone?: string): string {
  const shownIn = new Intl.DateTimeFormat(undefined, { timeZone: zone }).resolvedOptions().timeZone;
  return `${iso(ns)} · shown in ${shownIn}`;
}

/** The first and last of these start times, leaving out unrecorded ones. */
export function ranOf(starts: number[]): [number, number] | null {
  const times = starts.filter((ns) => ns > 0);
  if (!times.length) return null;
  // reduce, not Math.min(...times): a large session would overflow the call stack.
  return [times.reduce((a, b) => Math.min(a, b)), times.reduce((a, b) => Math.max(a, b))];
}

/** When a session's queries ran, first to last; null if none recorded it. */
export function ranBetween(ran: [number, number] | null, zone?: string): string | null {
  if (!ran) return null;
  const format = new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: "medium", timeStyle: "short" });
  return format.formatRange(toDate(ran[0]), toDate(ran[1]));
}

const midnight = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);

/** Which group of the session list a moment falls in, seen from `now`. */
export function ageGroup(ms: number, now: number): "Today" | "Yesterday" | "This week" | "Older" {
  const days = Math.round((midnight(now) - midnight(ms)) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "This week" : "Older";
}

/** A moment as short as is unambiguous from `now`: the time today, else the date. */
export function shortWhen(ms: number, now: number, zone?: string): string {
  const today = ageGroup(ms, now) === "Today";
  return new Intl.DateTimeFormat(undefined, today
    ? { timeZone: zone, timeStyle: "short" }
    : { timeZone: zone, dateStyle: "medium" }).format(new Date(ms));
}
