import { useEffect, useState, type MouseEvent } from "react";
import HomePage from "./HomePage";
import LabelPage from "./LabelPage";
import QueriesPage from "./QueriesPage";
import RunPage from "./RunPage";
import { TopBar } from "./shared";

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
  const run = /^\/runs\/([^/]+)$/.exec(path);
  const label = /^\/queries\/(.+)$/.exec(path);
  const tab = path === "/" ? "home" : path.startsWith("/queries") || run ? "queries" : null;
  return (
    <>
      <TopBar tab={tab} />
      {run ? <RunPage key={run[1]} id={decodeURIComponent(run[1]!)} />
        : label ? <LabelPage key={label[1]} label={decodeURIComponent(label[1]!)} />
        : path === "/queries" ? <QueriesPage />
        : path === "/" ? <HomePage />
        : <main className="npage"><p className="nquiet">No such page.</p></main>}
    </>
  );
}
