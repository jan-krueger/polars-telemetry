import { useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import type { Profile } from "../model/profile";
import type { Action } from "../state/viewer";
import { span } from "../lib/format";
import { finishes } from "../lib/replay";

const SPEEDS = [1, 4, 16];

/** Scrub or play through the query's run; the plan and node details follow. */
export default function ReplayBar({ profile, at, dispatch }: { profile: Profile; at: number | null; dispatch: Dispatch<Action> }) {
  const replay = profile.replay!;
  const end = profile.wall_ms;
  const t = at ?? end;
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
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

  const percent = (ms: number) => (end > 0 ? (ms / end) * 100 : 0);
  const ticks = useMemo(() => {
    const done = new Map<number, number>();
    for (const ms of finishes(replay)) done.set(ms, (done.get(ms) ?? 0) + 1);
    return (
      <div className="replay-marks" aria-hidden="true">
        {replay.times.map((ms) => <span key={`s${ms}`} className="replay-sample" style={{ left: `${percent(ms)}%` }} />)}
        {[...done].map(([ms, n]) => (
          <span key={ms} className="replay-mark" style={{ left: `${percent(ms)}%`, height: `${Math.min(18, 12 + n * 2)}px` }} />
        ))}
      </div>
    );
  }, [replay, end]);

  const go = (ms: number) => {
    setPlaying(false);
    dispatch({ type: "replayed", at: ms >= end ? null : Math.max(0, ms) });
  };
  const play = () => {
    if (playing) return setPlaying(false);
    if (at === null) dispatch({ type: "replayed", at: 0 });
    setPlaying(true);
  };

  return (
    <div className="replay" role="group" aria-label="Replay">
      <button className="pane-btn" onClick={play} aria-label={playing ? "Pause" : "Play"}>
        {playing
          ? <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 3.5v9M11 3.5v9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          : <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 3.2v9.6L12.5 8z" fill="currentColor" /></svg>}
      </button>
      <button className="pane-btn replay-speed" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}
              aria-label={`Playback speed ${speed} times; change`}>{speed}×</button>
      <div className="replay-track">
        {ticks}
        <input id="replay-position" type="range" min={0} max={end} step="any" value={t}
               onChange={(e) => go(Number(e.target.value))}
               aria-label="Moment of the query" aria-valuetext={at === null ? "the end" : `${span(t)} in`} />
      </div>
      <span className="replay-at">
        {at === null ? <>End · <b>{span(end)}</b></> : <><b>{span(t)}</b> of {span(end)}</>}
      </span>
      <span className="replay-note">
        Ticks: {replay.times.length} samples, interpolated between · tall ticks: nodes finishing
      </span>
    </div>
  );
}
