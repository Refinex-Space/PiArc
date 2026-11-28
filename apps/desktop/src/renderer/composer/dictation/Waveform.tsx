// The live waveform (addendum V-2.4): Core's measured envelope drawn as rounded bars around the
// middle line, newest on the right, gliding left while recording; quiet stretches are a dotted
// line. A held picture redraws only when levels changed (at most every 250 ms with reduced
// motion), and with reduced motion it moves in whole bars. It is decoration: hidden from
// assistive technology; the strip's text says what is happening. React renders it once; drawing never goes through React state.
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

/** Bar width and gap in CSS px; silence is a dot as wide as a bar. */
const BAR = 2;
const GAP = 3;
const STEP = BAR + GAP;
/** Below this loudness a bar is drawn as a faint dot: the line between words. */
const QUIET = 0.08;
/** Exponent applied to loudness for a bar's height. */
const SHAPE = 1.6;
/** Opacity of the dots. */
const DOT_ALPHA = 0.45;
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
    let drawnDrift = Number.NaN;
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
      const { live: moving, reducedMotion: reduced } = state.current;
      // While recording the picture glides left on the wall clock between Core's events; with
      // reduced motion, or when held, it moves only in whole bars and only when levels changed.
      const glide = moving && !reduced;
      const drift = glide ? levels.drift(now) : 0;
      if (drawnVersion === levels.version && drift === drawnDrift) return;
      if (reduced && drawnVersion !== -1 && now - drawnAt < REDUCED_FRAME_MS) return;
      const context = element.getContext('2d');
      if (context === null || width === 0) return;
      drawnVersion = levels.version;
      drawnDrift = drift;
      drawnAt = now;
      const ratio = element.width / Math.max(1, width);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      // One bar more than fits, so the one sliding out on the left is drawn until it is gone.
      const count = Math.max(1, Math.ceil(width / STEP) + 1);
      const values = levels.last(count);
      context.fillStyle = getComputedStyle(element).color;
      const middle = height / 2;
      const right = width - BAR - drift * STEP;
      for (let i = 0; i < values.length; i += 1) {
        const x = right - (values.length - 1 - i) * STEP;
        if (x + BAR < 0 || x > width) continue;
        // Loudness on a decibel scale, as level meters draw it: a microphone's speech peaks
        // around -30 to -10 dBFS, which a linear scale would flatten into the floor.
        const amplitude = loudness(values[i] ?? 0);
        const quiet = amplitude < QUIET;
        // The curve spreads the upper range, so ordinary speech keeps its rise and fall
        // instead of every syllable reaching the top.
        const bar = quiet ? BAR : Math.max(BAR * 2, amplitude ** SHAPE * height);
        context.globalAlpha = quiet ? DOT_ALPHA : 1;
        context.beginPath();
        context.roundRect(x, middle - bar / 2, BAR, bar, BAR / 2);
        context.fill();
      }
      context.globalAlpha = 1;
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
