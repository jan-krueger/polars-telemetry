import { useMemo, useReducer, useRef } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import Booting from "./components/Booting";
import Notice from "./components/Notice";
import Overview from "./components/Overview";
import PickedNode from "./components/PickedNode";
import QueryView from "./components/QueryView";
import useMoment from "./hooks/useMoment";
import { shareFragment } from "./share/link";
import { documentsFor } from "./share/session";
import { spansDays } from "./lib/time";
import { SessionsPage } from "./components/Sessions";
import Sidebar from "./components/Sidebar";
import StartPage from "./components/StartPage";
import TopBar from "./components/TopBar";
import useAddressBar from "./hooks/useAddressBar";
import usePanes from "./hooks/usePanes";
import useSessions from "./hooks/useSessions";
import { byNode } from "./lib/insights";
import { storageUnavailable } from "./lib/storage";
import {
  currentProfile, currentSession, initialState, reducer, sharedPrefix, visibleShapes,
} from "./state/viewer";

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { booted, sessions } = state;
  const { problems, report, importFiles, remove, save, rename, keep, loadExample } = useSessions(state, dispatch);
  useAddressBar(state, dispatch);
  const panes = usePanes();
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseFiles = () => fileInput.current?.click();

  const current = currentSession(state);
  const profiles = useMemo(() => current?.profiles ?? [], [current]);
  const profile = currentProfile(state);
  const shapes = useMemo(() => visibleShapes(state),
    [state.sessions, state.sessionId, state.search, state.sort]);
  const prefix = useMemo(() => sharedPrefix(profiles), [profiles]);
  const findings = useMemo(() => byNode(profile), [profile]);
  const { moment, physical } = useMoment(profile, state.replayAt);
  const withDates = useMemo(() => spansDays(profiles), [profiles]);

  return (
    <>
      <TopBar booted={booted} stored={sessions.length} fileInput={fileInput} onChoose={chooseFiles}
              onBrowse={() => dispatch({ type: "browsed", open: true })} onFiles={importFiles} />

      <div className="shell">
        <Sidebar sessions={sessions} current={current} shapes={shapes} prefix={prefix} search={state.search}
                 queryId={state.queryId} dispatch={dispatch} onKeep={keep} />

        <main>
          <Notice problems={problems} onDismiss={() => report([])} />
          {!booted ? (
            <Booting label="Loading sessions…" />
          ) : state.browsing ? (
            <SessionsPage sessions={sessions} currentId={state.sessionId} onKeep={keep}
                          storageNote={storageUnavailable() ? " (this page only)" : ""}
                          onPick={(sessionId) => dispatch({ type: "sessionPicked", sessionId })}
                          onClose={() => dispatch({ type: "browsed", open: false })}
                          onRename={rename} onDownload={save} onRemove={remove} />
          ) : !current ? (
            <StartPage onChoose={chooseFiles} onExample={loadExample} />
          ) : !current.profiles ? (
            <Booting label={`Opening ${current.name}…`} />
          ) : !profile ? (
            <Overview session={current} shapes={shapes} sort={state.sort} dispatch={dispatch} />
          ) : (
            <QueryView profile={profile} moment={moment} findings={findings} panes={panes}
                       node={state.node} focus={state.focus} replayAt={state.replayAt} dispatch={dispatch}
                       withDates={withDates}
                       share={{
                         link: () => {
                           const fragment = shareFragment(documentsFor(current, [profile]));
                           return { url: location.href.split("#")[0] + fragment, chars: fragment.length };
                         },
                         linkNote: "Opens this query in the viewer",
                         download: { label: "Download session", note: "Every query in it, as the .jsonl file", run: () => save(current) },
                       }} />
          )}
        </main>

        <aside className="rail right">
          {!state.browsing && (
            <PickedNode profile={profile} node={state.node} moment={moment} physical={physical} findings={findings}
                        onPick={(id) => dispatch({ type: "nodePicked", node: { plan: "physical", id } })} />
          )}
        </aside>
      </div>
    </>
  );
}
