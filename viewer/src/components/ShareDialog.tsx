import { useEffect, useRef } from "react";
import { num } from "../lib/format";

export type Copy = "link" | "markdown";

export interface Sharing {
  copied?: Copy;
  confirm?: { copy: Copy; text: string };
  tooLong?: number;
  manual?: { copy: Copy; text: string };
}

interface Props {
  sharing: Sharing;
  what: string;
  onCopy: (copy: Copy, text: string) => void;
  onDownload: () => void;
  onClose: () => void;
}

export default function ShareDialog({ sharing, what, onCopy, onDownload, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);
  const several = what.includes(" and ");

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
            <button className="btn" onClick={onClose} autoFocus>Cancel</button>
            <button className="btn btn--crit" onClick={() => onCopy(sharing.confirm!.copy, sharing.confirm!.text)}>
              Copy anyway
            </button>
          </div>
        </>
      )}
      {sharing.tooLong && (
        <>
          <h3 id="share-title">Too large for a link</h3>
          <p>This link would be {num(sharing.tooLong)} characters, more than chat tools and some
            browsers accept. Download the session and send the file instead.</p>
          <div className="dialog-actions">
            <button className="btn" onClick={onClose}>Close</button>
            <button className="btn btn--primary" onClick={onDownload} autoFocus>Download session</button>
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
