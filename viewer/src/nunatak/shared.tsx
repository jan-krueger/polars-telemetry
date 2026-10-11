import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { facets, type Filter } from "./api";
import { follow, go } from "./App";

export const DAY_MS = 86_400_000;
const KEPT = ["service", "environment", "host", "days"] as const;
const FIELDS = ["service", "environment", "host"] as const;
const RANGES: [number, string][] = [[1, "last 24 hours"], [7, "last 7 days"], [14, "last 14 days"], [30, "last 30 days"], [90, "last 90 days"]];
export const DEFAULT_DAYS = 14;

export function useLoad<T>(load: () => Promise<T>, key: string): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let current = true;
    load().then((loaded) => current && setValue(loaded)).catch(() => current && setValue(null));
    return () => {
      current = false;
    };
  }, [key]);
  return value;
}

export function useSearch(): [URLSearchParams, (changes: Record<string, string | null>, replace?: boolean) => void] {
  const [text, setText] = useState(location.search);
  useEffect(() => {
    const changed = () => setText(location.search);
    addEventListener("popstate", changed);
    return () => removeEventListener("popstate", changed);
  }, []);
  const params = useMemo(() => new URLSearchParams(text), [text]);
  const update = (changes: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(text);
    for (const [key, value] of Object.entries(changes)) if (value === null) next.delete(key); else next.set(key, value);
    const query = next.toString();
    go(`${location.pathname}${query ? `?${query}` : ""}`, replace);
  };
  return [params, update];
}

/** The service, environment and host the reader chose in the top bar. */
export function filterOf(params: URLSearchParams): Filter {
  return Object.fromEntries(FIELDS.filter((f) => params.get(f)).map((f) => [f, params.get(f)!]));
}

export const daysOf = (params: URLSearchParams): number => Number(params.get("days")) || DEFAULT_DAYS;

/** A path that keeps the reader's filters and range. */
export function link(path: string, params: URLSearchParams = new URLSearchParams(location.search)): string {
  const kept = new URLSearchParams(KEPT.filter((k) => params.get(k)).map((k) => [k, params.get(k)!]));
  const query = kept.toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

export const labelPath = (label: string): string => `/queries/${encodeURIComponent(label)}`;
export const runPath = (id: string): string => `/runs/${encodeURIComponent(id)}`;

export function Link({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  return <a href={link(to)} className={className} onClick={(e: MouseEvent<HTMLAnchorElement>) => follow(e)}>{children}</a>;
}

export function TopBar({ tab }: { tab: "home" | "queries" | null }) {
  const [params, update] = useSearch();
  const filter = filterOf(params);
  const days = daysOf(params);
  const key = `${JSON.stringify(filter)}${days}`;
  const counts = useLoad(() => facets({ since: Math.round((Date.now() - days * DAY_MS) * 1e6) }), String(days));
  return (
    <header className="top">
      <span className="brand">Nunatak</span>
      <nav className="ntabs">
        <a href={link("/", params)} onClick={follow} aria-current={tab === "home" ? "page" : undefined}>Home</a>
        <a href={link("/queries", params)} onClick={follow} aria-current={tab === "queries" ? "page" : undefined}>Queries</a>
      </nav>
      <span className="grow" />
      <div className="nfilters" key={key}>
        {FIELDS.map((field) => {
          const values = (counts?.[field] ?? []).map((c) => c.value).filter((v): v is string => v !== null);
          const chosen = params.get(field);
          if (!chosen && values.length < 2) return null;
          return (
            <label key={field} className={chosen ? "nchip on" : "nchip"}>
              {field}
              <select id={`filter-${field}`} value={chosen ?? ""} onChange={(e) => update({ [field]: e.target.value || null })}>
                <option value="">all</option>
                {chosen && !values.includes(chosen) && <option value={chosen}>{chosen}</option>}
                {values.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          );
        })}
        <label className="nchip">
          <select id="filter-days" aria-label="Time range" value={days} onChange={(e) => update({ days: Number(e.target.value) === DEFAULT_DAYS ? null : e.target.value })}>
            {RANGES.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
        </label>
      </div>
    </header>
  );
}
