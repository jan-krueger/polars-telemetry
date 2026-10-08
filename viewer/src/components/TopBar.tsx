import type { RefObject } from "react";
import { storageUnavailable } from "../lib/storage";

interface Props {
  booted: boolean;
  stored: number;
  fileInput: RefObject<HTMLInputElement | null>;
  onBrowse: () => void;
  onChoose: () => void;
  onFiles: (files: File[]) => void;
}

export default function TopBar({ booted, stored, fileInput, onBrowse, onChoose, onFiles }: Props) {
  return (
    <header className="top">
      <div className="brand">polars-telemetry <span>· profile viewer</span></div>
      <div className="toolbar">
        {booted && stored ? (
          <button className="link hint" onClick={onBrowse}>
            {stored} session{stored > 1 ? "s" : ""} stored
          </button>
        ) : (
          <span className="hint">{!booted ? "" : storageUnavailable() ? "storage unavailable" : "nothing loaded"}</span>
        )}
        <button className="btn" onClick={onChoose}>Open .jsonl</button>
        <input ref={fileInput} type="file" accept=".jsonl,.json" multiple hidden
               onChange={(e) => { if (e.target.files?.length) onFiles([...e.target.files]); e.target.value = ""; }} />
      </div>
    </header>
  );
}
