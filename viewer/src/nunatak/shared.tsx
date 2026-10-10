import { useEffect, useMemo, useState } from "react";
import type { Count, Facets } from "./api";
import { go } from "./App";

const FIELDS = ["service", "environment", "host", "status"] as const;

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

export function useSearch(): [URLSearchParams, (changes: Record<string, string | null>) => void] {
  const [text, setText] = useState(location.search);
  useEffect(() => {
    const changed = () => setText(location.search);
    addEventListener("popstate", changed);
    return () => removeEventListener("popstate", changed);
  }, []);
  const params = useMemo(() => new URLSearchParams(text), [text]);
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(text);
    for (const [key, value] of Object.entries(changes)) if (value === null) next.delete(key); else next.set(key, value);
    const query = next.toString();
    go(`${location.pathname}${query ? `?${query}` : ""}`);
  };
  return [params, update];
}

export function FacetList({ counts, params, update }: { counts: Facets | null; params: URLSearchParams; update: (changes: Record<string, string | null>) => void }) {
  return (
    <div className="nfacets">
      {FIELDS.map((field) => {
        const chosen = params.get(field);
        const values: Count[] = counts?.[field] ?? [];
        return (
          <section key={field}>
            <h3>{field}</h3>
            <button aria-pressed={chosen === null} onClick={() => update({ [field]: null })}><span>All</span></button>
            {values.map((count) => (
              <button key={count.value ?? ""} aria-pressed={chosen === count.value}
                      disabled={count.value === null || (count.runs === 0 && chosen !== count.value)}
                      onClick={() => update({ [field]: chosen === count.value ? null : count.value })}>
                <span>{count.value ?? "none"}</span><span className="dim">{count.runs}</span>
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}
