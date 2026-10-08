import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface ShareOption {
  key: string;
  label: string;
  note: string;
  onPick: () => void;
}

export default function ShareMenu({ options, done }: { options: ShareOption[]; done: string | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = () => [...(box.current?.querySelectorAll<HTMLButtonElement>(".share-item") ?? [])];

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener("pointerdown", away);
    return () => removeEventListener("pointerdown", away);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
  };

  return (
    <div className="share-box" ref={box} onKeyDown={open ? keys : undefined}>
      <button ref={button} className="btn share" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor"
             strokeWidth={done ? 2.2 : 1.6} strokeLinecap="round" strokeLinejoin="round" className={done ? "share-tick" : undefined}>
          <path d={done ? "M3 8.5l3.2 3L13 4.5" : "M8 10V2.5M5 5.5l3-3 3 3M3.5 8.5v4.5h9V8.5"} />
        </svg>
        Share
      </button>
      <span className="share-status" role="status">{done ?? ""}</span>
      {open && (
        <div className="share-menu" role="menu">
          {options.map((o) => (
            <button key={o.key} role="menuitem" className="share-item" onClick={() => { close(); o.onPick(); }}>
              <span className="share-label">{o.label}</span>
              <span className="share-note">{o.note}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
