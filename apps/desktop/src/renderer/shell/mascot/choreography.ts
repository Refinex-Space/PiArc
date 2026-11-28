// What the mascot does next, the way a desktop pet's behaviours are scheduled: long, uneven idle
// holds with blinks and glances, and now and then a move: a walk to a spot, a run of hops, a big
// jump, its i bouncing, a wave, a little dance or a nap. Motion frames are short (80–140 ms) and
// move by whole blocks, so it stays crisp. Pure: the random source is passed in.
import type { Pose } from './poses.js';

/** One frame: the pose, how long it holds, where it stands (blocks from the centre) and how
 * high it is off the floor (blocks). */
export interface Frame {
  readonly pose: Pose;
  readonly ms: number;
  readonly x: number;
  readonly lift: number;
}

/** How far the mascot may stray from the centre, in blocks, either way. */
export const TRAVEL = 6;

export type Behaviour =
  'idle' | 'glance' | 'walk' | 'hops' | 'jump' | 'ibounce' | 'wave' | 'dance' | 'nap';

/** Relative weights of the behaviours after an idle beat. */
const WEIGHTS: readonly (readonly [Behaviour, number])[] = [
  ['idle', 5],
  ['glance', 4],
  ['walk', 3],
  ['hops', 2],
  ['jump', 2],
  ['ibounce', 2],
  ['wave', 1],
  ['dance', 1],
  ['nap', 1],
];

export type Random = () => number;

function between(random: Random, low: number, high: number): number {
  return Math.round(low + random() * (high - low));
}

function clamp(x: number): number {
  return Math.max(-TRAVEL, Math.min(TRAVEL, x));
}

/** A direction that leans back toward the centre the further out it is. */
function direction(x: number, random: Random): 1 | -1 {
  if (x === 0) return random() < 0.5 ? -1 : 1;
  const towardCentre: 1 | -1 = x > 0 ? -1 : 1;
  return random() < 0.5 + Math.abs(x) / (2 * TRAVEL) ? towardCentre : towardCentre === 1 ? -1 : 1;
}

const hold = (pose: Pose, ms: number, x: number, lift = 0): Frame => ({ pose, ms, x, lift });

/** Coming in: a drop from above onto the floor, then a wave. */
export function arrival(): Frame[] {
  return [
    hold('air', 90, 0, 3),
    hold('air', 80, 0, 2),
    hold('air', 80, 0, 1),
    hold('land', 140, 0),
    hold('idle', 260, 0),
    ...wave(0),
  ];
}

function idleBeat(x: number, random: Random): Frame[] {
  const frames = [hold('idle', between(random, 900, 2200), x)];
  const r = random();
  if (r < 0.45) frames.push(hold('blink', 120, x), hold('idle', between(random, 300, 900), x));
  else if (r < 0.6) {
    // A double blink.
    frames.push(hold('blink', 100, x), hold('idle', 120, x), hold('blink', 100, x));
  }
  return frames;
}

function glance(x: number, random: Random): Frame[] {
  const order: Pose[] =
    random() < 0.5 ? ['lookL', 'idle', 'lookUp'] : ['lookUp', 'lookUpL', 'lookL'];
  return [...order.map((pose) => hold(pose, between(random, 500, 900), x)), hold('idle', 300, x)];
}

function walk(x: number, random: Random): Frame[] {
  const dir = direction(x, random);
  const target = clamp(x + dir * between(random, 2, 5));
  const frames: Frame[] = [];
  let at = x;
  let foot = 0;
  while (at !== target) {
    at += dir;
    frames.push(hold(foot % 2 === 0 ? 'step1' : 'step2', 130, at));
    foot += 1;
  }
  frames.push(hold('idle', 240, at));
  if (random() < 0.5) frames.push(hold(dir < 0 ? 'lookL' : 'lookUp', 600, at));
  return frames;
}

function hop(x: number, dir: 1 | -1): Frame[] {
  return [
    hold('squash', 100, x),
    hold('air', 80, clamp(x + dir), 1),
    hold('air', 110, clamp(x + 2 * dir), 2),
    hold('air', 80, clamp(x + 3 * dir), 1),
    hold('land', 120, clamp(x + 3 * dir)),
    hold('idle', 140, clamp(x + 3 * dir)),
  ];
}

function hops(x: number, random: Random): Frame[] {
  const dir = direction(x, random);
  const frames: Frame[] = [];
  let at = x;
  const count = between(random, 2, 3);
  for (let i = 0; i < count; i += 1) {
    // Turn back at the edge rather than pile up against it.
    const step: 1 | -1 = Math.abs(at + 3 * dir) > TRAVEL ? (dir === 1 ? -1 : 1) : dir;
    frames.push(...hop(at, step));
    at = clamp(at + 3 * step);
  }
  frames.push(hold('idle', 400, at));
  return frames;
}

function jump(x: number): Frame[] {
  return [
    hold('squash', 120, x),
    hold('stretch', 80, x),
    hold('air', 80, x, 1),
    hold('air', 80, x, 2),
    hold('air', 180, x, 3),
    hold('air', 80, x, 2),
    hold('air', 80, x, 1),
    hold('stretch', 80, x),
    hold('land', 160, x),
    hold('idle', 400, x),
  ];
}

function ibounce(x: number): Frame[] {
  return [
    hold('ihop1', 80, x),
    hold('ihop2', 160, x),
    hold('ihop1', 80, x),
    hold('idle', 120, x),
    hold('ihop1', 80, x),
    hold('ihop2', 160, x),
    hold('ihop1', 80, x),
    hold('idle', 400, x),
  ];
}

function wave(x: number): Frame[] {
  return [
    hold('lookUp', 240, x),
    hold('wave1', 140, x),
    hold('wave2', 140, x),
    hold('wave1', 140, x),
    hold('wave2', 140, x),
    hold('wave1', 140, x),
    hold('idle', 500, x),
  ];
}

function dance(x: number): Frame[] {
  const frames: Frame[] = [];
  for (const side of [1, -1, 1, -1] as const) {
    const at = clamp(x + (side === 1 ? 1 : 0));
    frames.push(hold('squash', 120, at), hold('stretch', 120, at), hold('ihop2', 140, at));
  }
  frames.push(hold('land', 140, x), hold('idle', 500, x));
  return frames;
}

function nap(x: number): Frame[] {
  const frames: Frame[] = [hold('blink', 400, x)];
  for (let i = 0; i < 3; i += 1) {
    frames.push(hold('sleep1', 420, x), hold('sleep2', 420, x), hold('sleep3', 420, x));
  }
  frames.push(hold('blink', 240, x), hold('idle', 160, x), hold('blink', 100, x));
  frames.push(hold('stretch', 160, x), hold('idle', 600, x));
  return frames;
}

/** Picks a behaviour by weight. */
export function pick(random: Random): Behaviour {
  const total = WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let roll = random() * total;
  for (const [behaviour, weight] of WEIGHTS) {
    roll -= weight;
    if (roll < 0) return behaviour;
  }
  return 'idle';
}

/** The frames of `behaviour` from position `x`. */
export function framesOf(behaviour: Behaviour, x: number, random: Random): Frame[] {
  switch (behaviour) {
    case 'idle':
      return idleBeat(x, random);
    case 'glance':
      return glance(x, random);
    case 'walk':
      return walk(x, random);
    case 'hops':
      return hops(x, random);
    case 'jump':
      return jump(x);
    case 'ibounce':
      return ibounce(x);
    case 'wave':
      return wave(x);
    case 'dance':
      return dance(x);
    case 'nap':
      return nap(x);
  }
}

/** The next run of frames: always an idle beat first, then a picked behaviour. */
export function nextFrames(x: number, random: Random): Frame[] {
  const beat = idleBeat(x, random);
  const behaviour = pick(random);
  return [...beat, ...(behaviour === 'idle' ? [] : framesOf(behaviour, x, random))];
}
