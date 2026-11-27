// Source locations from a page's dev build (design addendum B3.2): React 19 keeps the stack of
// each JSX element (`_debugStack`), whose first frame below the JSX factory is where the element
// was written, in the served (transformed) code; the served file's source map turns that into
// the original file and line. Everything here reads page data: the stack, the code and the map
// are bounded, and a map that does not parse gives no location.
//
// The stack parsing and the frame choice are adapted from bippy (MIT, Copyright (c) Aiden Bai;
// `packages/bippy/src/source/parse-stack.ts`, `parse-debug-stack.ts` and the segment lookup of
// `symbolication.ts`, commit fbafc407ca31): V8 frames only, no structured call sites (the stack
// arrives as text), and a local VLQ decoder in place of `@jridgewell/sourcemap-codec`.

/** One frame of a V8 stack: `fn (file:line:column)` or `file:line:column`. */
export interface StackFrame {
  readonly fn?: string;
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
}

/** The characters of a stack this module reads. */
export const MAX_STACK = 16 * 1024;

/** React's marker below which frames are React's own (bippy's `REACT_STACK_BOTTOM_FRAME_PATTERNS`). */
const BOTTOM_FRAME = /react[-_]stack[-_]bottom[-_]frame/u;

/** The frames of a V8 stack string; lines that are not frames are skipped. */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stack.slice(0, MAX_STACK).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    const body = line.slice(3);
    // `fn (location)` or a bare location; the location ends with `:line:column`.
    const wrapped = /^(.*?) \((.+)\)$/u.exec(body);
    const fn = wrapped?.[1];
    const location = wrapped?.[2] ?? body;
    const position = /^(.+):(\d+):(\d+)$/u.exec(location);
    if (position === null) continue;
    const [, file = '', lineText = '', columnText = ''] = position;
    if (file === '<anonymous>' || file.startsWith('eval') || file === 'native') continue;
    frames.push({
      ...(fn === undefined || fn === '' ? {} : { fn }),
      file,
      line: Number(lineText),
      column: Number(columnText),
    });
  }
  return frames;
}

/**
 * Where a React 19 element was created: the first frame after the JSX factory, above React's
 * bottom-frame marker. Stacks without the marker were not captured during a render and give
 * nothing (bippy's `isTrusted`).
 */
export function usageFrame(stack: string): StackFrame | undefined {
  const text = stack.slice(0, MAX_STACK);
  const bottom = BOTTOM_FRAME.exec(text);
  if (bottom === null) return undefined;
  const above = text.slice(0, text.lastIndexOf('\n', bottom.index));
  // The first frame is the JSX factory itself (`jsxDEV`).
  return parseStack(above).slice(1)[0];
}

/** The `sourceMappingURL` comment of a served script, if any (the last one counts). */
export function sourceMappingUrl(code: string): string | undefined {
  const pattern = /\/\/[#@][ \t]+sourceMappingURL=([^\s'"]+)[ \t]*$/gmu;
  let found: string | undefined;
  for (const match of code.matchAll(pattern)) found = match[1];
  return found;
}

/** A decoded source map: `mappings[line]` holds `[column, source, line, column]` segments. */
export interface SourceMap {
  readonly sources: readonly string[];
  readonly sourceRoot: string;
  readonly mappings: readonly (readonly (readonly number[])[])[];
}

/** The most sources and mapping characters a map may have. */
const MAP_LIMITS = { sources: 10_000, mappings: 32 * 1024 * 1024 } as const;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGITS = new Map(Array.from(BASE64, (ch, index) => [ch, index]));

/** Decodes a `mappings` string; `undefined` when it is not valid VLQ. */
export function decodeMappings(text: string): number[][][] | undefined {
  const lines: number[][][] = [];
  // Source, original line and original column carry over between lines; the column does not.
  const state = [0, 0, 0, 0, 0];
  for (const lineText of text.split(';')) {
    state[0] = 0;
    const segments: number[][] = [];
    for (const segmentText of lineText.split(',')) {
      if (segmentText === '') continue;
      const values = vlq(segmentText);
      if (values === undefined || ![1, 4, 5].includes(values.length)) return undefined;
      const segment: number[] = [];
      values.forEach((value, index) => {
        state[index] = (state[index] ?? 0) + value;
        segment.push(state[index] ?? 0);
      });
      segments.push(segment);
    }
    segments.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
    lines.push(segments);
  }
  return lines;
}

function vlq(text: string): number[] | undefined {
  const values: number[] = [];
  let shift = 0;
  let value = 0;
  for (const ch of text) {
    const digit = DIGITS.get(ch);
    if (digit === undefined) return undefined;
    value += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      if (shift > 30) return undefined;
      continue;
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
    shift = 0;
    value = 0;
  }
  return shift === 0 ? values : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A standard (not indexed) version 3 map, checked; `undefined` for anything else. */
export function parseSourceMap(value: unknown): SourceMap | undefined {
  if (!isRecord(value) || value.version !== 3) return undefined;
  const { sources, mappings, sourceRoot } = value;
  if (
    !Array.isArray(sources) ||
    sources.length > MAP_LIMITS.sources ||
    typeof mappings !== 'string' ||
    mappings.length > MAP_LIMITS.mappings ||
    (sourceRoot !== undefined && sourceRoot !== null && typeof sourceRoot !== 'string')
  ) {
    return undefined;
  }
  const names = sources.map((source: unknown) => (typeof source === 'string' ? source : ''));
  const decoded = decodeMappings(mappings);
  if (decoded === undefined) return undefined;
  return {
    sources: names,
    sourceRoot: typeof sourceRoot === 'string' ? sourceRoot : '',
    mappings: decoded,
  };
}

/** The original source index, line and column (1-based line and column) of a served position. */
export function originalPosition(
  map: SourceMap,
  line: number,
  column: number,
): { readonly source: number; readonly line: number; readonly column: number } | undefined {
  const segments = map.mappings[line - 1];
  if (segments === undefined || segments.length === 0) return undefined;
  // The last segment that starts at or before the (0-based) column.
  const wanted = column - 1;
  let low = 0;
  let high = segments.length - 1;
  let found: readonly number[] | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (segment !== undefined && (segment[0] ?? 0) <= wanted) {
      found = segment;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (found === undefined || found.length < 4) return undefined;
  const [, source = -1, originalLine = -1, originalColumn = -1] = found;
  if (source < 0 || source >= map.sources.length || originalLine < 0) return undefined;
  return { source, line: originalLine + 1, column: originalColumn + 1 };
}

/**
 * Source `index` of a map, as an address: a URL (`http:`, `file:`, `webpack:`) or an absolute
 * path stays as written; a relative source joins `sourceRoot` and resolves against `base` (the
 * map's own URL, or the script's for an inline map).
 */
export function mapSource(map: SourceMap, index: number, base: string): string {
  const source = map.sources[index] ?? '';
  const absolute = /^[a-z][a-z\d+.-]*:/iu.test(source) || /^(?:\/|[a-z]:[\\/])/iu.test(source);
  if (absolute) return source;
  const joined =
    map.sourceRoot === '' ? source : `${map.sourceRoot.replace(/\/?$/u, '/')}${source}`;
  if (!/^https?:/u.test(base)) return joined;
  try {
    return new URL(joined, base).toString();
  } catch {
    return joined;
  }
}
