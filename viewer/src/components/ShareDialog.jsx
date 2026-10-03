import { useEffect, useRef } from "react";
import { num } from "../lib/format";

export default function ShareDialog({ sharing, what, onCopy, onDownload, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="share-title"
            onCancel={(e) => { e.preventDefault(); onClose(); }}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {sharing.confirm && (
        <>
          <h3 id="share-title">This link may contain personal data</h3>
          <p>The {what} {what.includes(" and ") ? "were" : "was"} not masked before export, so the link carries
            everything in {what.includes(" and ") ? "them" : "it"}:</p>
          <ul>
            <li>literal values from filters and expressions</li>
            <li>paths of the scanned files</li>
            <li>the query label and the line of code that ran it</li>
          </ul>
          <p className="dialog-note">Anyone the link reaches can read these, and chat tools and browser
            history keep it.</p>
          <div className="dialog-actions">
            <button className="btn" onClick={onClose} autoFocus>Cancel</button>
            <button className="btn btn--crit" onClick={() => onCopy(sharing.confirm)}>Copy link anyway</button>
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
          <h3 id="share-title">Copy the link</h3>
          <p>The browser did not allow copying. Select the link and copy it yourself.</p>
          <input readOnly id="share-link" value={sharing.manual}
                 onFocus={(e) => e.target.select()} autoFocus />
          <div className="dialog-actions">
            <button className="btn" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </dialog>
  );
}
