import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type KeyboardEvent } from "react";
import type { Profile } from "../model/profile";
import type { QueryAction } from "../state/viewer";
import { span } from "../lib/format";
import { busy, finishes, replayEnd, type Stretch } from "../lib/replay";

const WHOLE_RUN_MS = 12_000;

const times = (v: number): string => `${v >= 10 ? Math.round(v) : Number(v.toPrecision(2))}×`;

/** Scrub or play through the query's run over a chart of how many threads it kept busy. */
export default function ReplayBar({ profile, at, dispatch, live = false }: { profile: Profile; at: number | null; dispatch: Dispatch<QueryAction>; live?: boolean }) {
  const replay = profile.replay!;
  const end = replayEnd(profile);
  const t = at ?? end;
  const speeds = useMemo(() => {
    const fitted = end / WHOLE_RUN_MS;
    return Math.abs(Math.log2(fitted)) < 0.5 ? [1] : [fitted, 1];
  }, [end]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(speeds[0]!);
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
  const done = useMemo(() => [...new Set(finishes(replay))], [replay]);
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
      <button className="pane-btn replay-speed" onClick={() => setSpeed(speeds[(speeds.indexOf(speed) + 1) % speeds.length]!)}
              aria-label={`Playback speed ${times(speed)}; change`}>{times(speed)}</button>
      <div className="replay-track">
        <BusyChart stretches={threads} end={end} t={at} />
        <div className="replay-marks" aria-hidden="true">
          {done.map((ms) => <span key={ms} className="replay-mark" style={{ left: `${(ms / end) * 100}%` }} />)}
        </div>
        <input id="replay-position" type="range" min={0} max={end} step="any" value={t}
               onChange={(e) => go(Number(e.target.value))} onKeyDown={keys}
               aria-label="Moment of the query" aria-valuetext={`${span(t)} in`} />
      </div>
      {live && at !== null && <button className="pane-btn replay-live" onClick={() => go(end)}>Back to live</button>}
      <span className="replay-at">{live && at === null ? <><b className="replay-now">● live</b> · {span(end)}</> : <><b>{span(t)}</b> / {span(end)}</>}</span>
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
