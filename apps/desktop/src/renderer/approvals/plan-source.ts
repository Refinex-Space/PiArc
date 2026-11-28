// Where rendered plan text comes from in the plan's Markdown source (ADR-0103). The plan panel
// shows the plan rendered, but comments stay anchored to UTF-16 offsets of the source (ADR-0042
// rule 3), because those are what the model submitted and what Core checks. Each rendered block
// knows the source lines it came from; inside a block, rendered characters are matched to
// source characters in order, skipping the markup the rendering removed (`**`, list markers,
// link targets, escapes). Rendered text is a subsequence of its source in every construct the
// plan renderer produces, so the greedy match is exact for text and stays inside the block for
// anything else.

/** UTF-16 offsets of the start of every line of `text` (lines end at CRLF, LF or CR). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 13 && text.charCodeAt(i + 1) === 10) {
      i += 1;
      starts.push(i + 1);
    } else if (c === 10 || c === 13) {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** The source range `[start, end)` of 1-based lines `first..last` (without the last newline). */
export function linesRange(
  text: string,
  starts: readonly number[],
  first: number,
  last: number,
): { start: number; end: number } {
  const start = starts[Math.max(0, first - 1)] ?? text.length;
  const next = starts[last];
  let end = next ?? text.length;
  if (next !== undefined) {
    if (text.charCodeAt(end - 1) === 10) end -= 1;
    if (text.charCodeAt(end - 1) === 13) end -= 1;
  }
  return { start, end: Math.max(start, end) };
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 0xa0;
}

/** Rendered characters a search for the next match may skip at most (markup, link targets). */
const LOOKAHEAD = 2048;

/**
 * For each character of `rendered`, the offset in `source` it shows (from `base`), or -1 when it
 * has none (text the rendering added). Whitespace matches any whitespace.
 */
export function alignRendered(rendered: string, source: string, base = 0): Int32Array {
  const map = new Int32Array(rendered.length).fill(-1);
  let at = 0;
  for (let i = 0; i < rendered.length; i += 1) {
    const want = rendered.charCodeAt(i);
    const space = isSpace(want);
    const limit = Math.min(source.length, at + LOOKAHEAD);
    for (let j = at; j < limit; j += 1) {
      const got = source.charCodeAt(j);
      if (got === want || (space && isSpace(got))) {
        map[i] = base + j;
        at = j + 1;
        break;
      }
    }
  }
  return map;
}

/**
 * The source range a rendered range `[from, to)` of one block shows: from the first mapped
 * character to just after the last one. Undefined when nothing in it maps (only added text).
 */
export function sourceRange(
  map: Int32Array,
  from: number,
  to: number,
): { start: number; end: number } | undefined {
  let start = -1;
  for (let i = Math.max(0, from); i < Math.min(to, map.length); i += 1) {
    const at = map[i] ?? -1;
    if (at >= 0) {
      start = at;
      break;
    }
  }
  let end = -1;
  for (let i = Math.min(to, map.length) - 1; i >= Math.max(0, from); i -= 1) {
    const at = map[i] ?? -1;
    if (at >= 0) {
      end = at + 1;
      break;
    }
  }
  return start < 0 || end <= start ? undefined : { start, end };
}

/**
 * The rendered ranges of one block that show source `[start, end)`: runs of consecutive
 * rendered characters whose source falls inside it (a comment's marks).
 */
export function renderedRuns(
  map: Int32Array,
  start: number,
  end: number,
): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let open = -1;
  let last = -1;
  for (let i = 0; i <= map.length; i += 1) {
    const at = i < map.length ? (map[i] ?? -1) : -1;
    if (at >= start && at < end) {
      if (open < 0) open = i;
      last = i;
    } else if (open >= 0 && (at >= 0 || i === map.length)) {
      // Text the rendering added between two inside characters stays in the run; a mapped
      // character outside the range ends it.
      runs.push({ from: open, to: last + 1 });
      open = -1;
    }
  }
  return runs;
}
