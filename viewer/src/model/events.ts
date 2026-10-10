// An events file holds each query's life; the viewer turns it into profiles that carry their samples.

import { EVENTS_SCHEMA, isObject } from "./schema";

type Doc = Record<string, unknown>;

export const isEvent = (value: unknown): value is Doc => isObject(value) && value.schema === EVENTS_SCHEMA;

interface Life {
  started?: Doc;
  progress: Doc[];
  finished?: Doc;
}

/** One profile document per query, in the order queries first appear, each with its samples. */
export function profilesFromEvents(events: Doc[]): Doc[] {
  const lives = new Map<string, Life>();
  for (const event of events) {
    if (typeof event.query_id !== "string") continue;
    let life = lives.get(event.query_id);
    if (!life) lives.set(event.query_id, (life = { progress: [] }));
    if (event.type === "query.started") life.started = event;
    else if (event.type === "query.progress") life.progress.push(event);
    else if (event.type === "query.finished") life.finished = event;
  }
  const docs: Doc[] = [];
  for (const life of lives.values()) {
    const replay = life.progress.length
      ? { replay: { samples: life.progress.map((p) => ({ t: p.elapsed_ms, nodes: p.nodes })) } }
      : {};
    const last = life.progress.at(-1)?.elapsed_ms;
    if (isObject(life.finished?.profile)) docs.push({ ...life.finished.profile, ...replay });
    else if (isObject(life.started?.profile)) {
      docs.push({ ...life.started.profile, unfinished: true, wall_ms: typeof last === "number" ? last : 0, ...replay });
    }
  }
  return docs;
}
