import { Component } from "react";
import { dropAll } from "../lib/storage";

/** A malformed profile throws during render. Without this the whole tree
 *  unmounts to a blank page, and because the session was already stored the
 *  blank page survives a reload with no way back. */
export default class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h1>The viewer hit an error</h1>
        <p>A stored session could not be rendered. Removing it should recover.</p>
        <pre>{String(this.state.error?.message || this.state.error)}</pre>
        <button className="btn" onClick={async () => { await dropAll(); location.reload(); }}>
          Remove stored sessions and reload
        </button>
      </div>
    );
  }
}
