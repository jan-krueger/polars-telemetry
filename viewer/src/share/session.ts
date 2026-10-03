/** Between share links and the viewer's sessions. */

import type { Profile, Session } from "../model/profile";
import { readProfile } from "../model/read";

/** A session opened from a link: shown, not stored, until the reader keeps it. */
export function sharedSession(fragment: string, documents: unknown[], now: number): Session {
  const profiles: Profile[] = [];
  documents.forEach((document, position) => {
    const read = readProfile(document, position);
    if ("profile" in read) profiles.push(read.profile);
  });
  return {
    id: `shared-${now}`,
    name: profiles.length > 1 ? "Shared queries" : "Shared query",
    importedAt: now,
    bytes: JSON.stringify(documents).length,
    profiles,
    raw: documents,
    shared: fragment,
  };
}

/** The documents as written for these profiles of the session, in their order. */
export function documentsFor(session: Session, profiles: Profile[]): unknown[] {
  const byId = new Map<string, unknown>();
  session.raw.forEach((document, position) => {
    const read = readProfile(document, position);
    if ("profile" in read) byId.set(read.profile.query_id, document);
  });
  return profiles.map((p) => byId.get(p.query_id)).filter((d) => d !== undefined);
}
