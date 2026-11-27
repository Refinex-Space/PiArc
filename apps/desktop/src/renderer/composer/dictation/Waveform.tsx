// The live waveform (addendum V-2.4): Core's measured envelope drawn as rounded bars around the
// middle line, redrawn on animation frames only when new levels arrived (at most every 250 ms
// with reduced motion). It is decoration: hidden from assistive technology; the strip's text
// says what is happening. React renders it once; drawing never goes through React state.
import { useEffect, useRef } from 'react';

import type { Levels } from './levels.js';

/** The quietest level drawn above the floor, in dBFS. */
const FLOOR_DB = -55;

/** A peak (0–1) as 0–1 on a decibel scale from `FLOOR_DB` to 0 dBFS. */
export function loudness(peak: number): number {
  if (!(peak > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, peak));
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

/** Bar width and gap in CSS px. */
const BAR = 2;
const GAP = 2;
const REDUCED_FRAME_MS = 250;

export function Waveform({
  levels,
  live,
  reducedMotion,
}: {
  readonly levels: Levels;
  /** Recording: draw new levels; otherwise hold the last picture. */
  readonly live: boolean;
  readonly reducedMotion: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ live, reducedMotion });
  state.current = { live, reducedMotion };

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return undefined;
    let frame = 0;
    let drawnVersion = -1;
    let drawnAt = 0;
    let width = 0;
    let height = 0;
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      width = element.clientWidth;
      height = element.clientHeight;
      element.width = Math.max(1, Math.round(width * ratio));
      element.height = Math.max(1, Math.round(height * ratio));
      drawnVersion = -1;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const draw = (now: number) => {
      frame = window.requestAnimationFrame(draw);
      if (drawnVersion === levels.version) return;
      if (state.current.reducedMotion && drawnVersion !== -1 && now - drawnAt < REDUCED_FRAME_MS) {
        return;
      }
      const context = element.getContext('2d');
      if (context === null || width === 0) return;
      drawnVersion = levels.version;
      drawnAt = now;
      const ratio = element.width / Math.max(1, width);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const count = Math.max(1, Math.floor((width + GAP) / (BAR + GAP)));
      const values = levels.last(count);
      context.fillStyle = getComputedStyle(element).color;
      const middle = height / 2;
      for (let i = 0; i < values.length; i += 1) {
        // Loudness on a decibel scale, as level meters draw it: a microphone's speech peaks
        // around -30 to -10 dBFS, which a linear scale would flatten into the floor. A floor
        // keeps silence visible as a flat line.
        const amplitude = loudness(values[i] ?? 0);
        const bar = Math.max(BAR, amplitude * (height - 2));
        const x = i * (BAR + GAP);
        context.beginPath();
        context.roundRect(x, middle - bar / 2, BAR, bar, BAR / 2);
        context.fill();
      }
    };
    frame = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [levels]);

  return (
    <canvas
      ref={canvas}
      className={`dictation-waveform${live ? ' is-live' : ''}`}
      aria-hidden="true"
      data-testid="dictation-waveform"
    />
  );
}
