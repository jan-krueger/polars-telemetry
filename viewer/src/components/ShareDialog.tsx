import { useEffect, useRef, useState } from "react";
import { num } from "../lib/format";
import { stopWarningUnmasked } from "../lib/prefs";

export type Copy = "link" | "markdown";

export interface Sharing {
  copied?: Copy;
  confirm?: { copy: Copy; text: string };
  tooLong?: { chars: number; text: string };
  manual?: { copy: Copy; text: string };
}

interface Props {
  sharing: Sharing;
  what: string;
  onCopy: (copy: Copy, text: string) => void;
  onCopyLong: (text: string) => void;
  download: string;
  onDownload: () => void;
  onClose: () => void;
}

export default function ShareDialog({ sharing, what, onCopy, onCopyLong, download, onDownload, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);
  const several = what.includes(" and ");
  const [quiet, setQuiet] = useState(false);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="share-title"
            onCancel={(e) => { e.preventDefault(); onClose(); }}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {sharing.confirm && (
        <>
          <h3 id="share-title">This {sharing.confirm.copy === "link" ? "link" : "text"} may contain personal data</h3>
          <p>The {what} {several ? "were" : "was"} not masked before export, so
            the {sharing.confirm.copy === "link" ? "link" : "text"} carries everything in {several ? "them" : "it"}:</p>
          <ul>
            <li>literal values from filters and expressions</li>
            <li>paths of the scanned files</li>
            <li>the query label and the line of code that ran it</li>
          </ul>
          <p className="dialog-note">
            {sharing.confirm.copy === "link"
              ? "Anyone the link reaches can read these, and chat tools and browser history keep it."
              : "Anyone who can see where you paste it can read these."}
          </p>
          <div className="dialog-actions">
            <label className="dialog-check">
              <input id="skip-unmasked-warning" type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
              Don't ask again in this browser
            </label>
            <button className="btn" onClick={onClose} autoFocus>Cancel</button>
            <button className="btn btn--crit" onClick={() => {
              if (quiet) stopWarningUnmasked();
              onCopy(sharing.confirm!.copy, sharing.confirm!.text);
            }}>
              Copy anyway
            </button>
          </div>
        </>
      )}
      {sharing.tooLong && (
        <>
          <h3 id="share-title">Too large for a link</h3>
          <p>This link would be {num(sharing.tooLong.chars)} characters, more than chat tools and some
            browsers accept. Download the session and send the file instead.</p>
          <div className="dialog-actions">
            <button className="btn" onClick={onClose}>Close</button>
            <button className="btn" onClick={() => onCopyLong(sharing.tooLong!.text)}>Copy anyway</button>
            <button className="btn btn--primary" onClick={onDownload} autoFocus>{download}</button>
          </div>
        </>
      )}
      {sharing.manual && (
        <>
          <h3 id="share-title">Copy the {sharing.manual.copy === "link" ? "link" : "Markdown"}</h3>
          <p>The browser did not allow copying. Select it and copy it yourself.</p>
          {sharing.manual.copy === "link" ? (
            <input readOnly id="share-link" value={sharing.manual.text}
                   onFocus={(e) => e.target.select()} autoFocus />
          ) : (
            <textarea readOnly id="share-markdown" value={sharing.manual.text} rows={12}
                      onFocus={(e) => e.target.select()} autoFocus />
          )}
          <div className="dialog-actions">
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </dialog>
  );
}
