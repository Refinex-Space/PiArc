// Checks of the terminal results that cross a process boundary (T34): Core's JSON text in the
// main process, and the main process's replies in the preload script. Both sides run the same
// checks, so a malformed value never reaches the page.
import type {
  TerminalInfoView,
  TerminalLinkInfo,
  TerminalMatchInfo,
  TerminalOpened,
  TerminalPasteOutcome,
} from './ipc.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** `JSON.parse(text)` as `unknown`, or `undefined` for text that is not JSON. */
export function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function terminalOpenedOf(value: unknown): TerminalOpened | undefined {
  if (!isRecord(value) || !count(value.terminalId) || typeof value.taskId !== 'string') {
    return undefined;
  }
  const restored = typeof value.restored === 'string' ? value.restored : null;
  return { terminalId: value.terminalId, taskId: value.taskId, restored };
}

export function terminalLinkOf(value: unknown): TerminalLinkInfo | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.uri !== 'string' ||
    !count(value.row) ||
    !count(value.start) ||
    !count(value.end)
  ) {
    return undefined;
  }
  return { uri: value.uri, row: value.row, start: value.start, end: value.end };
}

function pointOf(value: unknown): { row: number; col: number } | undefined {
  return isRecord(value) && count(value.row) && count(value.col)
    ? { row: value.row, col: value.col }
    : undefined;
}

export function terminalMatchesOf(value: unknown): readonly TerminalMatchInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const matches: TerminalMatchInfo[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const start = pointOf(entry.start);
    const end = pointOf(entry.end);
    if (start === undefined || end === undefined) return undefined;
    matches.push({ start, end });
  }
  return matches;
}

export function terminalInfoOf(value: unknown): TerminalInfoView | undefined {
  if (
    !isRecord(value) ||
    !count(value.terminalId) ||
    !count(value.cols) ||
    !count(value.rows) ||
    typeof value.title !== 'string' ||
    typeof value.pwd !== 'string' ||
    typeof value.alternateScreen !== 'boolean' ||
    typeof value.shared !== 'boolean'
  ) {
    return undefined;
  }
  const info: {
    -readonly [K in keyof TerminalInfoView]: TerminalInfoView[K];
  } = {
    terminalId: value.terminalId,
    cols: value.cols,
    rows: value.rows,
    title: value.title,
    pwd: value.pwd,
    alternateScreen: value.alternateScreen,
    shared: value.shared,
  };
  if (typeof value.sessionId === 'string') info.sessionId = value.sessionId;
  if (typeof value.taskId === 'string') info.taskId = value.taskId;
  return info;
}

export function isPasteOutcome(value: unknown): value is TerminalPasteOutcome {
  return value === 'pasted' || value === 'unsafe' || value === 'empty';
}
