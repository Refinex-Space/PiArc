// PiArc's mascot on the new session page and the first-run welcome (ADR-0110): the working mark come to life in solid blocks (poses
// in mascot/poses.ts). It drops in, waves, then lives on its own: idle holds with blinks and
// glances, walks, runs of hops, jumps, its i bouncing, a dance or a nap (mascot/choreography.ts).
//
// Frames switch by setting attributes on the drawn paths, so React does not render per frame.
// It holds still (standing in the middle) while "reduce motion" is on: app.css cuts every CSS
// animation to zero length then, and this element's entrance animation shows it. It pauses
// while the window is hidden. Decorative only: hidden from assistive technology.
import { useEffect, useRef } from 'react';

import { isWindowVisible, onWindowVisibility } from '../app/window-visibility.js';
import { arrival, nextFrames, TRAVEL, type Frame } from './mascot/choreography.js';
import { POSE_COLS, POSES, STAGE_ROWS, posePath, type Pose } from './mascot/poses.js';

const NAMES = Object.keys(POSES).filter((name): name is Pose => name in POSES);
const WIDTH = POSE_COLS + 2 * TRAVEL;
/** CSS px per block on the new session page. */
const BLOCK = 6;
const REST: Frame = { pose: 'idle', ms: 0, x: 0, lift: 0 };
/** How often a still mascot checks whether motion is allowed again. */
const STILL_CHECK_MS = 1000;

export function Mascot({
  block = BLOCK,
  testId = 'home-mascot',
  className,
}: {
  /** CSS px per block. */
  readonly block?: number;
  readonly testId?: string;
  /** Added to `home-mascot`, which carries the color and the entrance. */
  readonly className?: string;
} = {}) {
  const svg = useRef<SVGSVGElement>(null);
  const body = useRef<SVGGElement>(null);
  useEffect(() => {
    const root = svg.current;
    const group = body.current;
    if (root === null || group === null) return undefined;
    const paths = new Map<string, SVGPathElement>();
    for (const path of group.querySelectorAll('path')) paths.set(path.dataset.pose ?? '', path);
    let shown: Pose = 'idle';
    let x = 0;
    let queue: Frame[] = [];
    let arrived = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const still = () => getComputedStyle(root).animationDuration === '0s';
    const show = (frame: Frame) => {
      if (frame.pose !== shown) {
        paths.get(shown)?.setAttribute('visibility', 'hidden');
        paths.get(frame.pose)?.setAttribute('visibility', 'visible');
        shown = frame.pose;
      }
      group.setAttribute('transform', `translate(${String(frame.x)} ${String(-frame.lift)})`);
      root.dataset.pose = frame.pose;
      x = frame.x;
    };
    const tick = () => {
      timer = undefined;
      if (!isWindowVisible()) return;
      if (still()) {
        show(REST);
        queue = [];
        timer = setTimeout(tick, STILL_CHECK_MS);
        return;
      }
      if (queue.length === 0) {
        queue = arrived ? nextFrames(x, Math.random) : arrival();
        arrived = true;
      }
      const frame = queue.shift() ?? REST;
      show(frame);
      timer = setTimeout(tick, frame.ms);
    };
    const stopListening = onWindowVisibility(() => {
      if (isWindowVisible() && timer === undefined) tick();
    });
    tick();
    return () => {
      clearTimeout(timer);
      stopListening();
    };
  }, []);
  return (
    <svg
      ref={svg}
      className={className === undefined ? 'home-mascot' : `home-mascot ${className}`}
      data-testid={testId}
      data-pose="idle"
      viewBox={`0 0 ${String(WIDTH)} ${String(STAGE_ROWS)}`}
      width={WIDTH * block}
      height={STAGE_ROWS * block}
      aria-hidden="true"
      focusable="false"
    >
      <g ref={body}>
        {NAMES.map((name) => (
          <path
            key={name}
            data-pose={name}
            d={posePath(name, TRAVEL)}
            visibility={name === 'idle' ? 'visible' : 'hidden'}
          />
        ))}
      </g>
    </svg>
  );
}
