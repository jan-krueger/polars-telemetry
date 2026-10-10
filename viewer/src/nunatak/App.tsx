import { useEffect, useState, type MouseEvent } from "react";
import NowPage from "./NowPage";
import QueriesPage from "./QueriesPage";
import RunPage from "./RunPage";

export function go(path: string, replace = false) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function follow(event: MouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  go(event.currentTarget.getAttribute("href") ?? "/");
}

function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const changed = () => setPath(location.pathname);
    addEventListener("popstate", changed);
    return () => removeEventListener("popstate", changed);
  }, []);
  return path;
}

export default function App() {
  const path = usePath();
  const run = /^\/queries\/([^/]+)$/.exec(path);
  const tab = path.startsWith("/queries") ? "queries" : "now";
  return (
    <>
      <header className="top">
        <span className="brand">polars-telemetry <span>· Nunatak</span></span>
        <nav className="ntabs">
          <a href="/" onClick={follow} aria-current={tab === "now" ? "page" : undefined}>Now</a>
          <a href="/queries" onClick={follow} aria-current={tab === "queries" ? "page" : undefined}>Queries</a>
        </nav>
      </header>
      {run ? <RunPage id={decodeURIComponent(run[1]!)} />
        : path === "/queries" ? <QueriesPage />
        : path === "/" ? <NowPage />
        : <div className="nsoon">No such page.</div>}
    </>
  );
}
