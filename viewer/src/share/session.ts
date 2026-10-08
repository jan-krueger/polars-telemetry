import type { Profile, Session } from "../model/profile";
import { readProfile, sessionInfo } from "../model/read";
import { title } from "../state/viewer";

export function sharedSession(fragment: string, documents: unknown[], now: number): Session {
  const profiles: Profile[] = [];
  documents.forEach((document, position) => {
    const read = readProfile(document, position);
    if ("profile" in read) profiles.push(read.profile);
  });
  const info = sessionInfo({
    id: `shared-${now}`,
    name: profiles[0] ? title(profiles[0]) + (profiles.length > 1 ? `, ${profiles.length} runs` : "") : "Shared link",
    importedAt: now,
    bytes: JSON.stringify(documents).length,
  }, profiles);
  return { ...info, profiles, raw: documents, shared: fragment };
}

export function documentsFor(session: Session, profiles: Profile[]): unknown[] {
  const byId = new Map<string, unknown>();
  (session.raw ?? []).forEach((document, position) => {
    const read = readProfile(document, position);
    if ("profile" in read) byId.set(read.profile.query_id, document);
  });
  return profiles.map((p) => byId.get(p.query_id)).filter((d) => d !== undefined);
}
