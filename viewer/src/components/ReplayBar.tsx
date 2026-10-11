import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type KeyboardEvent } from "react";
import type { Profile } from "../model/profile";
import type { QueryAction } from "../state/viewer";
import { span } from "../lib/format";
import { busy, replayEnd, speedChoices, type Stretch } from "../lib/replay";

const times = (v: number): string => (v === 1 ? "Normal" : `${v >= 10 ? Math.round(v) : Number(v.toPrecision(2))}×`);

/** Scrub or play through the query's run over a chart of how many threads it kept busy. */
export default function ReplayBar({ profile, at, dispatch, live = false }: { profile: Profile; at: number | null; dispatch: Dispatch<QueryAction>; live?: boolean }) {
  const replay = profile.replay!;
  const end = replayEnd(profile);
  const t = at ?? end;
  const choices = useMemo(() => speedChoices(end), [end]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(choices.fitted);
  const position = useRef(t);
  position.current = t;
  const frameMs = profile.plan.physical.length > 200 ? 120 : 50;

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    let shown = last;
    const tick = (now: number) => {
      const next = position.current + (now - last) * speed;
      last = now;
      if (next >= end) {
        setPlaying(false);
        dispatch({ type: "replayed", at: null });
        return;
      }
      position.current = next;
      if (now - shown >= frameMs) {
        shown = now;
        dispatch({ type: "replayed", at: next });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, end, frameMs, dispatch]);

  const steps = useMemo(() => [0, ...replay.times, end], [replay, end]);
  const threads = useMemo(() => busy(replay, profile.plan.physical, end), [replay, profile, end]);

  const go = (ms: number) => {
    setPlaying(false);
    dispatch({ type: "replayed", at: ms >= end ? null : Math.max(0, ms) });
  };
  const play = () => {
    if (playing) return setPlaying(false);
    if (at === null) dispatch({ type: "replayed", at: 0 });
    setPlaying(true);
  };
  const keys = (e: KeyboardEvent) => {
    const next = e.key === "ArrowRight" ? steps.find((ms) => ms > t + 0.5)
      : e.key === "ArrowLeft" ? steps.findLast((ms) => ms < t - 0.5) : undefined;
    if (e.key === " ") play();
    else if (next !== undefined) go(next);
    else return;
    e.preventDefault();
  };

  return (
    <div className="replay" role="group" aria-label="Replay">
      <button className="pane-btn" onClick={play} aria-label={playing ? "Pause" : "Play"}>
        {playing
          ? <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 3.5v9M11 3.5v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          : <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 3.2v9.6L12.5 8z" fill="currentColor" /></svg>}
      </button>
      <SpeedMenu speed={speed} speeds={choices.speeds} end={end} onPick={setSpeed} />
      <div className="replay-track">
        <BusyChart stretches={threads} end={end} t={at} />
        <input id="replay-position" type="range" min={0} max={end} step="any" value={t}
               onChange={(e) => go(Number(e.target.value))} onKeyDown={keys}
               aria-label="Moment of the query" aria-valuetext={`${span(t)} in`} />
      </div>
      <span className="replay-at">{live && at === null ? <b>{span(end)}</b> : <><b>{span(t)}</b> / {span(end)}</>}</span>
      {live && (
        <button className={at === null ? "replay-live replay-live--now" : "replay-live"} onClick={() => go(end)} disabled={at === null}
                aria-label={at === null ? "Live" : "Go to live"}>live</button>
      )}
    </div>
  );
}

/** Playback speed, picked from a list as on a video player. */
function SpeedMenu({ speed, speeds, end, onPick }: { speed: number; speeds: number[]; end: number; onPick: (speed: number) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = () => [...(box.current?.querySelectorAll<HTMLButtonElement>(".speed-item") ?? [])];

  useEffect(() => {
    if (!open) return;
    (items().find((b) => b.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
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
    const now = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(now + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
  };
  const shown = speeds.includes(speed) ? speeds : [...speeds, speed].sort((a, b) => a - b);

  return (
    <div className="speed-box" ref={box} onKeyDown={open ? keys : undefined}>
      <button ref={button} className="pane-btn replay-speed" aria-haspopup="menu" aria-expanded={open}
              aria-label={`Playback speed: ${times(speed)}`} onClick={() => setOpen(!open)}>{speed === 1 ? "1×" : times(speed)}</button>
      {open && (
        <div className="speed-menu" role="menu" aria-label="Playback speed">
          <div className="speed-head">Playback speed</div>
          {shown.map((s) => (
            <button key={s} role="menuitemradio" aria-checked={s === speed} className="speed-item" onClick={() => { onPick(s); close(); }}>
              <span className="speed-tick" aria-hidden="true">{s === speed ? "✓" : ""}</span>
              <span>{times(s)}</span>
              <span className="speed-lasts">{span(end / s)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Threads busy per stretch as bars; what lies after the replayed moment `t` is paler. */
function BusyChart({ stretches, end, t }: { stretches: Stretch[]; end: number; t: number | null }) {
  const clip = useId();
  const peak = Math.max(1e-9, ...stretches.map((s) => s.load));
  const x = (ms: number) => (end > 0 ? (ms / end) * 1000 : 0);
  const bars = stretches.map((s) => {
    const h = Math.max(4, (s.load / peak) * 100);
    return <rect key={s.from} x={x(s.from)} width={x(s.to) - x(s.from)} y={100 - h} height={h} />;
  });
  return (
    <svg className="busy-chart" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
      {t !== null && (
        <>
          <clipPath id={clip}><rect width={x(t)} height={100} /></clipPath>
          <g className="busy-ahead">{bars}</g>
        </>
      )}
      <g className="busy-past" clipPath={t !== null ? `url(#${clip})` : undefined}>{bars}</g>
    </svg>
  );
}
