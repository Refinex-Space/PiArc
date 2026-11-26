// Three-way merge for the merge view (design addendum M4.2): the base and both sides are split
// into lines (line ends kept, so CRLF survives), each side is matched to the base with Myers'
// diff, and the stretches between lines all three share become chunks: changed on one side only
// (taken automatically), changed the same way on both, or a conflict the user resolves.

/** A stretch of the merged file. */
export type MergeChunk =
  | { readonly kind: 'same'; readonly lines: readonly string[] }
  | {
      readonly kind: 'yours' | 'theirs' | 'both';
      readonly lines: readonly string[];
      readonly base: readonly string[];
    }
  | {
      readonly kind: 'conflict';
      readonly base: readonly string[];
      readonly yours: readonly string[];
      readonly theirs: readonly string[];
    };

/** How a conflict was resolved. */
export type Resolution = 'yours' | 'theirs' | 'yoursFirst' | 'theirsFirst' | 'neither';

/** Above this many differences between a side and the base, the middle is one changed block. */
const MAX_EDITS = 4000;

/** `text` as lines, each with its line end. */
export function linesOf(text: string): string[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu);
  return lines === null ? [] : [...lines];
}

/** Myers' shortest edit script between `a` and `b`: the matched index pairs, in order; `undefined`
 * when they differ in more than `MAX_EDITS` places. */
function myers(a: readonly string[], b: readonly string[]): [number, number][] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m, a, b);
    }
  }
  return undefined;
}

function backtrack(
  trace: readonly Int32Array[],
  offset: number,
  n: number,
  m: number,
  a: readonly string[],
  b: readonly string[],
): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    if (v === undefined) break;
    const k = x - y;
    const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY && a[x - 1] === b[y - 1]) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  // The first round has no edit: what is left at the start is a common prefix.
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

/** For each line of `base`, the index of the matching line of `side` (or -1). */
function matchOf(base: readonly string[], side: readonly string[]): Int32Array {
  const match = new Int32Array(base.length).fill(-1);
  let start = 0;
  while (start < base.length && start < side.length && base[start] === side[start]) {
    match[start] = start;
    start++;
  }
  let endBase = base.length;
  let endSide = side.length;
  while (endBase > start && endSide > start && base[endBase - 1] === side[endSide - 1]) {
    endBase--;
    endSide--;
    match[endBase] = endSide;
  }
  const middle = myers(base.slice(start, endBase), side.slice(start, endSide));
  for (const [i, j] of middle ?? []) match[start + i] = start + j;
  return match;
}

function equal(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** The chunks of merging `yours` and `theirs` from `base`. */
export function merge3(base: string, yours: string, theirs: string): MergeChunk[] {
  const a = linesOf(base);
  const y = linesOf(yours);
  const t = linesOf(theirs);
  const my = matchOf(a, y);
  const mt = matchOf(a, t);
  const chunks: MergeChunk[] = [];
  const same: string[] = [];
  const flush = () => {
    if (same.length > 0) chunks.push({ kind: 'same', lines: same.splice(0) });
  };
  let i = 0;
  let iy = 0;
  let it = 0;
  for (;;) {
    while (i < a.length && my[i] === iy && mt[i] === it) {
      same.push(a[i] ?? '');
      i++;
      iy++;
      it++;
    }
    if (i >= a.length && iy >= y.length && it >= t.length) break;
    let k = i;
    while (k < a.length && !((my[k] ?? -1) >= iy && (mt[k] ?? -1) >= it)) k++;
    const ey = k < a.length ? (my[k] ?? y.length) : y.length;
    const et = k < a.length ? (mt[k] ?? t.length) : t.length;
    const b = a.slice(i, k);
    const ys = y.slice(iy, ey);
    const ts = t.slice(it, et);
    flush();
    if (equal(ys, b)) chunks.push({ kind: 'theirs', lines: ts, base: b });
    else if (equal(ts, b)) chunks.push({ kind: 'yours', lines: ys, base: b });
    else if (equal(ys, ts)) chunks.push({ kind: 'both', lines: ys, base: b });
    else chunks.push({ kind: 'conflict', base: b, yours: ys, theirs: ts });
    i = k;
    iy = ey;
    it = et;
  }
  flush();
  return chunks;
}

/** The lines a conflict contributes once resolved; `undefined` while it is not. */
export function resolvedLines(
  chunk: Extract<MergeChunk, { kind: 'conflict' }>,
  resolution: Resolution | undefined,
): readonly string[] | undefined {
  switch (resolution) {
    case 'yours':
      return chunk.yours;
    case 'theirs':
      return chunk.theirs;
    case 'yoursFirst':
      return [...chunk.yours, ...chunk.theirs];
    case 'theirsFirst':
      return [...chunk.theirs, ...chunk.yours];
    case 'neither':
      return chunk.base;
    case undefined:
      return undefined;
  }
}

/** A line ends with a line end before another line is appended after it. */
function terminated(lines: readonly string[]): string[] {
  const out = [...lines];
  const last = out.at(-1);
  if (last !== undefined && !last.endsWith('\n')) out[out.length - 1] = `${last}\n`;
  return out;
}

/** The merged text; an unresolved conflict is written with Git's markers. */
export function resultText(
  chunks: readonly MergeChunk[],
  resolutions: ReadonlyMap<number, Resolution>,
  labels: { readonly yours: string; readonly theirs: string },
): string {
  let text = '';
  chunks.forEach((chunk, index) => {
    if (chunk.kind !== 'conflict') {
      text += chunk.lines.join('');
      return;
    }
    const lines = resolvedLines(chunk, resolutions.get(index));
    if (lines !== undefined) {
      text += lines.join('');
      return;
    }
    text +=
      `<<<<<<< ${labels.yours}\n${terminated(chunk.yours).join('')}=======\n` +
      `${terminated(chunk.theirs).join('')}>>>>>>> ${labels.theirs}\n`;
  });
  return text;
}

/** Whether `text` still has a line that starts like a conflict marker. */
export function hasMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})(\s|$)/mu.test(text);
}
