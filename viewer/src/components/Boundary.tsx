import { Component, type ReactNode } from "react";
import { dropAll, dropSession } from "../lib/storage";
import { fromHash } from "../state/route";

// A stored profile that throws in render would otherwise blank the page on every reload.
export default class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    const open = fromHash(location.hash).sessionId;
    return (
      <div className="crash">
        <h1>The viewer hit an error</h1>
        <p>A stored session could not be rendered. Removing it should recover.</p>
        <pre>{(this.state.error instanceof Error && this.state.error.message) || String(this.state.error)}</pre>
        {open ? (
          <button className="btn" onClick={async () => { await dropSession(open); location.hash = ""; location.reload(); }}>
            Remove the open session and reload
          </button>
        ) : null}
        <button className="btn" onClick={async () => { await dropAll(); location.hash = ""; location.reload(); }}>
          Remove all stored sessions and reload
        </button>
      </div>
    );
  }
}
