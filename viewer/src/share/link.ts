// Every dictionary ever shipped stays here, so old links keep opening.

import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { isObject } from "../model/schema";
import dictionary1 from "./dictionary-1.txt?raw";

const DICTIONARIES: Record<number, Uint8Array> = { 1: strToU8(dictionary1) };
const CURRENT = 1;
const KEY = "share=";

/** Chat tools truncate longer links. */
export const MAX_LINK_CHARS = 30_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Samples stay out of links: they make one far too long, and the downloaded session keeps them. */
/** Samples stay out of links; a query the recording cut off keeps each node's last counters instead. */
function withoutReplay(document: unknown): unknown {
  if (!isObject(document) || !("replay" in document)) return document;
  const { replay, ...rest } = document;
  if (rest.unfinished !== true || !isObject(replay) || !Array.isArray(replay.samples) || !isObject(rest.plan)) return rest;
  const last = new Map<string, unknown>();
  const samples = replay.samples.filter(isObject).sort((a, b) => Number(a.t) - Number(b.t));
  for (const sample of samples) if (isObject(sample.nodes)) for (const [id, counters] of Object.entries(sample.nodes)) last.set(id, counters);
  const physical = Array.isArray(rest.plan.physical) ? rest.plan.physical : [];
  return {
    ...rest,
    plan: { ...rest.plan, physical: physical.map((n) => (isObject(n) && !n.metrics && last.has(String(n.id)) ? { ...n, metrics: last.get(String(n.id)) } : n)) },
  };
}

export function shareFragment(documents: unknown[]): string {
  const packed = deflateSync(strToU8(JSON.stringify(documents.map(withoutReplay))), { level: 9, dictionary: DICTIONARIES[CURRENT] });
  return `#${KEY}${CURRENT}.${toBase64Url(packed)}`;
}

export const isShareFragment = (hash: string): boolean => hash.replace(/^#/, "").startsWith(KEY);

export type Opened = { documents: unknown[] } | { problem: string };

export function openShareFragment(hash: string): Opened {
  const body = hash.replace(/^#/, "").slice(KEY.length);
  const dot = body.indexOf(".");
  const version = Number(body.slice(0, dot));
  const dictionary = DICTIONARIES[version];
  if (dot < 1 || !dictionary) return { problem: "this link was made by a newer viewer" };
  try {
    const documents: unknown = JSON.parse(strFromU8(inflateSync(fromBase64Url(body.slice(dot + 1)), { dictionary })));
    if (!Array.isArray(documents)) return { problem: "the link holds no profiles" };
    return { documents };
  } catch {
    return { problem: "the link is incomplete or damaged; it may have been cut short" };
  }
}
