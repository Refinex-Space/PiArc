// File ranges use one-based lines; character offsets use UTF-16 like the native textarea.
export interface ViewerSettings {
  autoSave: boolean;
  tabIndents: boolean;
  wordWrap: boolean;
  indentGuides: boolean;
  showWhitespace: boolean;
  scrollPastEnd: boolean;
  tabSize: number;
}

export const DEFAULT_VIEWER_SETTINGS: ViewerSettings = {
  autoSave: true,
  tabIndents: true,
  wordWrap: true,
  indentGuides: true,
  showWhitespace: false,
  scrollPastEnd: false,
  tabSize: 4,
};

export interface FileSelection {
  startLine: number;
  endLine: number;
  text: string;
  comment?: string;
}

export function sourceLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/u);
}

export function textSelection(text: string, start: number, end: number): FileSelection | undefined {
  if (start === end) return undefined;
  const startLine = sourceLines(text.slice(0, start)).length;
  const selection = text.slice(start, end);
  return {
    startLine,
    endLine: startLine + sourceLines(selection.replace(/(?:\r\n|\r|\n)$/u, '')).length - 1,
    text: selection,
  };
}

export function parseLocation(input: string, count: number) {
  const match = /^(\d+)(?::(\d+))?$/u.exec(input.trim());
  if (!match) return undefined;
  const line = Number(match[1]),
    column = Number(match[2] ?? 1);
  if (line < 1 || line > count || column < 1 || !Number.isSafeInteger(column)) return undefined;
  return { line, column };
}

export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regexp: boolean;
}
export interface FindMatch {
  line: number;
  start: number;
  end: number;
}
export interface FindResult {
  matches: FindMatch[];
  truncated: boolean;
  invalid: boolean;
}
export const NONE_FOUND: FindResult = { matches: [], truncated: false, invalid: false };

function findPattern(query: string, options: FindOptions) {
  let pattern = options.regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (options.wholeWord) pattern = '(?<![\\p{L}\\p{N}_])(?:' + pattern + ')(?![\\p{L}\\p{N}_])';
  return pattern;
}

function findFlags(options: FindOptions) {
  return options.matchCase ? 'gu' : 'giu';
}

// Called off the UI thread. A find operation is stopped when a new query arrives or its time budget expires.
export function findMatches(
  lines: readonly string[],
  query: string,
  options: FindOptions,
): FindResult {
  if (!query) return NONE_FOUND;
  let regex: RegExp;
  try {
    regex = new RegExp(findPattern(query, options), findFlags(options));
  } catch {
    return { ...NONE_FOUND, invalid: true };
  }
  const matches: FindMatch[] = [];
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(regex)) {
      if (!match[0].length) continue;
      if (matches.length === 2000) return { matches, truncated: true, invalid: false };
      matches.push({ line: index + 1, start: match.index, end: match.index + match[0].length });
    }
  }
  return { matches, truncated: false, invalid: false };
}

const LINE_BREAK = /\r\n|\n|\r/u;

interface LineSlice {
  text: string;
  offset: number;
}

/** Line slices in the same order as `sourceLines`, with offsets into the original text. */
function lineSlices(text: string): LineSlice[] {
  const slices: LineSlice[] = [];
  let offset = 0;
  while (offset <= text.length) {
    const rest = text.slice(offset);
    const newline = LINE_BREAK.exec(rest);
    if (!newline) {
      slices.push({ text: rest, offset });
      break;
    }
    slices.push({ text: rest.slice(0, newline.index), offset });
    const next = offset + newline.index + newline[0].length;
    if (next === text.length) {
      slices.push({ text: '', offset: next });
      break;
    }
    offset = next;
  }
  return slices;
}

function expandReplacement(replacement: string, match: RegExpExecArray) {
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (_whole, token: string) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    return match[Number(token)] ?? '';
  });
}

/**
 * Replace the current match, or every match. Newlines in `text` are preserved.
 * Returns undefined when the pattern is invalid.
 */
export function replaceMatches(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions,
  target: 'all' | FindMatch,
): string | undefined {
  if (!query) return text;
  const slices = lineSlices(text);
  const found = findMatches(
    slices.map((slice) => slice.text),
    query,
    options,
  );
  if (found.invalid) return undefined;
  const hits =
    target === 'all'
      ? found.matches
      : found.matches.filter(
          (hit) => hit.line === target.line && hit.start === target.start && hit.end === target.end,
        );
  if (!hits.length) return text;
  let regex: RegExp;
  try {
    regex = new RegExp(findPattern(query, options), findFlags(options));
  } catch {
    return undefined;
  }
  const edits: { from: number; to: number; insert: string }[] = [];
  for (const hit of hits) {
    const slice = slices[hit.line - 1];
    if (!slice) continue;
    regex.lastIndex = hit.start;
    const match = regex.exec(slice.text);
    if (match?.index !== hit.start) continue;
    edits.push({
      from: slice.offset + hit.start,
      to: slice.offset + hit.end,
      insert: options.regexp ? expandReplacement(replacement, match) : replacement,
    });
  }
  edits.sort((a, b) => b.from - a.from);
  let next = text;
  for (const edit of edits) next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to);
  return next;
}

/** One selection covering the first match through the last, in document order. */
export function selectionFromMatches(
  text: string,
  matches: readonly FindMatch[],
): FileSelection | undefined {
  const first = matches[0];
  const last = matches.at(-1);
  if (!first || !last) return undefined;
  const slices = lineSlices(text);
  const start = slices[first.line - 1];
  const end = slices[last.line - 1];
  if (!start || !end) return undefined;
  return {
    startLine: first.line,
    endLine: last.line,
    text: text.slice(start.offset + first.start, end.offset + last.end),
  };
}

export function previewKind(path: string) {
  const extension = path.toLowerCase().split('.').at(-1);
  switch (extension) {
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown';
    case 'csv':
    case 'tsv':
      return extension;
    case 'html':
    case 'htm':
      return 'html';
    case 'svg':
      return 'svg';
    default:
      return null;
  }
}

export interface TablePreview {
  rows: string[][];
  truncated: boolean;
  invalid: boolean;
}
export function parseTable(
  source: string,
  delimiter: string,
  rowLimit = 300,
  columnLimit = 80,
): TablePreview {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    truncated = false;
  const finishField = () => {
    if (row.length < columnLimit) row.push(field);
    else truncated = true;
    field = '';
    closed = false;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (source[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
      continue;
    }
    if (ch === delimiter) finishField();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      finishField();
      rows.push(row);
      row = [];
      if (rows.length === rowLimit && i + 1 < source.length)
        return { rows, truncated: true, invalid: false };
    } else if (ch === '"' && !field && !closed) quoted = true;
    else if (closed || ch === '"') return { rows, truncated, invalid: true };
    else field += ch;
  }
  if (source && (row.length || field.length || closed || source.endsWith(delimiter))) {
    finishField();
    rows.push(row);
  }
  return { rows, truncated, invalid: quoted };
}

// Apply a single editable range so indenting a selection is a single native undo step.
export function indentSelection(
  text: string,
  start: number,
  end: number,
  size: number,
  outdent: boolean,
) {
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  if (start === end && !outdent) {
    let column = 0;
    for (const ch of text.slice(from, start)) column += ch === '\t' ? size - (column % size) : 1;
    const insert = ' '.repeat(size - (column % size));
    return {
      from: start,
      to: start,
      insert,
      start: start + insert.length,
      end: start + insert.length,
    };
  }
  const after = text.indexOf('\n', Math.max(start, end - 1));
  const to = after < 0 ? text.length : after;
  const adjusted = text.slice(from, to).split('\n');
  let offset = from,
    newStart = start,
    newEnd = end,
    changed = false;
  for (const [i, line] of adjusted.entries()) {
    const indent = line.startsWith('\t') ? 1 : Math.min(size, /^ */u.exec(line)?.[0].length ?? 0);
    if (outdent) {
      adjusted[i] = line.slice(indent);
      newStart -= Math.max(0, Math.min(indent, start - offset));
      newEnd -= Math.max(0, Math.min(indent, end - offset));
      changed ||= indent > 0;
    } else {
      adjusted[i] = ' '.repeat(size) + line;
      if (start >= offset) newStart += size;
      if (end >= offset) newEnd += size;
      changed = true;
    }
    offset += line.length + 1;
  }
  return changed
    ? { from, to, insert: adjusted.join('\n'), start: newStart, end: newEnd }
    : undefined;
}
