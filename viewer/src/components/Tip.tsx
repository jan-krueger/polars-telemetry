// Portalled to body so scrolling panes and the React Flow canvas cannot clip it.

import {
  cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type FocusEvent, type MouseEvent, type ReactElement, type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const HOVER_DELAY_MS = 120;
const GAP = 6;
const MARGIN = 8;

type Anchor = ReactElement<{
  onMouseEnter?: (e: MouseEvent) => void;
  onMouseLeave?: (e: MouseEvent) => void;
  onFocus?: (e: FocusEvent) => void;
  onBlur?: (e: FocusEvent) => void;
  ref?: unknown;
  "aria-describedby"?: string;
}>;

export default function Tip({ content, children }: { content: ReactNode; children: Anchor }) {
  const id = useId();
  const anchor = useRef<HTMLElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  const show = useCallback((delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPlace(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("wheel", hide, { passive: true });
    return () => {
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("wheel", hide);
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return;
    const a = anchor.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    const above = a.top - GAP - b.height;
    const top = above >= MARGIN ? above : a.bottom + GAP;
    const centred = a.left + a.width / 2 - b.width / 2;
    const left = Math.min(Math.max(centred, MARGIN), window.innerWidth - b.width - MARGIN);
    setPlace({ left, top });
  }, [open]);

  if (content === null || content === undefined || content === "") return children;

  const props = children.props;
  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => { anchor.current = node; },
    onMouseEnter: (e: MouseEvent) => { props.onMouseEnter?.(e); show(HOVER_DELAY_MS); },
    onMouseLeave: (e: MouseEvent) => { props.onMouseLeave?.(e); hide(); },
    onFocus: (e: FocusEvent) => { props.onFocus?.(e); show(0); },
    onBlur: (e: FocusEvent) => { props.onBlur?.(e); hide(); },
    "aria-describedby": open ? id : props["aria-describedby"],
  });

  return (
    <>
      {trigger}
      {open && createPortal(
        <div id={id} role="tooltip" ref={bubble} className="tip"
             style={place ? { left: place.left, top: place.top } : { left: -9999, top: -9999 }}>
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}

export function TipText({ term, children, note }: { term?: ReactNode; children?: ReactNode; note?: ReactNode }) {
  return (
    <>
      {term ? <div className="tip-term">{term}</div> : null}
      {children ? <div>{children}</div> : null}
      {note ? <div className="tip-note">{note}</div> : null}
    </>
  );
}
