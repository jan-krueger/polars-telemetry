import { useMemo, useReducer, useRef } from "react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import Booting from "./components/Booting";
import NodeDetails from "./components/NodeDetails";
import Notice from "./components/Notice";
import Overview from "./components/Overview";
import QueryView from "./components/QueryView";
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
  currentProfile, currentSession, findNode, initialState, reducer, sharedPrefix, visibleShapes,
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
  const physical = state.node?.plan === "physical";

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
            <QueryView state={state} dispatch={dispatch} session={current} profile={profile}
                       findings={findings} panes={panes} onDownload={save} />
          )}
        </main>

        <aside className="rail right">
          {!state.browsing && (
            <NodeDetails node={findNode(profile, state.node)}
                         plan={physical ? profile?.plan.physical : undefined}
                         findings={physical ? findings.get(state.node!.id) : undefined} />
          )}
        </aside>
      </div>
    </>
  );
}
