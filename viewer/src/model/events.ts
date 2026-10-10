// An events file holds each query's life; the viewer turns it into profiles that carry their samples.

import { EVENTS_SCHEMA, isObject } from "./schema";

type Doc = Record<string, unknown>;

export const isEvent = (value: unknown): value is Doc => isObject(value) && value.schema === EVENTS_SCHEMA;

interface Life {
  started?: Doc;
  samples: { t: unknown; nodes: unknown }[];
  finished?: Doc;
}

/** Each query's life so far, one event at a time: a whole file, or a stream as it arrives. */
export class EventLog {
  private readonly lives = new Map<string, Life>();

  /** Takes in one event; returns the query it belongs to, if any. */
  apply(event: Doc): string | null {
    if (typeof event.query_id !== "string") return null;
    let life = this.lives.get(event.query_id);
    if (!life) this.lives.set(event.query_id, (life = { samples: [] }));
    if (event.type === "query.started") life.started = event;
    else if (event.type === "query.progress") life.samples.push({ t: event.elapsed_ms, nodes: event.nodes });
    else if (event.type === "query.finished") life.finished = event;
    return event.query_id;
  }

  /** The query as a profile document with its samples, or null before anything describes it. */
  document(queryId: string): Doc | null {
    const life = this.lives.get(queryId);
    if (!life) return null;
    const replay = life.samples.length ? { replay: { samples: life.samples } } : {};
    if (isObject(life.finished?.profile)) return { ...life.finished.profile, ...replay };
    if (!isObject(life.started?.profile)) return null;
    const last = life.samples.at(-1)?.t;
    return { ...life.started.profile, unfinished: true, wall_ms: typeof last === "number" ? last : 0, ...replay };
  }

  /** Every query, in the order each first appeared. */
  documents(): Doc[] {
    return [...this.lives.keys()].map((id) => this.document(id)).filter((doc): doc is Doc => doc !== null);
  }
}

/** One profile document per query, in the order queries first appear, each with its samples. */
export function profilesFromEvents(events: Doc[]): Doc[] {
  const log = new EventLog();
  for (const event of events) log.apply(event);
  return log.documents();
}
