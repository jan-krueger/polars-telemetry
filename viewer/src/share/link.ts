/**
 * Profiles packed into a link: deflated against a dictionary of typical
 * profile text, then base64url-encoded, behind `#share=<version>.`.
 *
 * The part after `#` never leaves the browser. Every dictionary ever used
 * stays here, so a link keeps opening after a newer one ships.
 */

import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import dictionary1 from "./dictionary-1.txt?raw";

const DICTIONARIES: Record<number, Uint8Array> = { 1: strToU8(dictionary1) };
const CURRENT = 1;
const KEY = "share=";

/** Longer links get cut short by chat tools, so they are not offered. */
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

/** The `#share=…` fragment for these profile documents, as written. */
export function shareFragment(documents: unknown[]): string {
  const packed = deflateSync(strToU8(JSON.stringify(documents)), { level: 9, dictionary: DICTIONARIES[CURRENT] });
  return `#${KEY}${CURRENT}.${toBase64Url(packed)}`;
}

/** Whether a URL fragment is a share link at all. */
export const isShareFragment = (hash: string): boolean => hash.replace(/^#/, "").startsWith(KEY);

export type Opened = { documents: unknown[] } | { problem: string };

/** The documents a share fragment carries, or why it cannot be opened. */
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
