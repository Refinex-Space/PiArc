// Ported from ego-browser package/ego-browser/src/output-sink.ts (ego-lite commit 56589ea8, MIT,
// see LICENSE). PiArc: no process lifecycle flush (`installLifecycleFlush`, `writeSync`): the
// script host flushes once per run into a string it hands to the main process; `observeOutput`
// lets the host send buffered chunks early as provisional output for a run that never finishes.

import { formatCliLogValue } from './format.js';
import {
  consumeUnhandledPageNotices,
  resetPageNotices,
  type UnhandledPageNotice,
} from './page-discovery.js';

/**
 * Round output stays buffered until completion because bytes written before a hard
 * stop cannot be recalled. A hard stop discards business output and Page notices,
 * then emits its owned guidance once. Each run starts with `resetSink()`.
 */

export interface WritableLike {
  write(chunk: string): unknown;
}

export type RoundConsole = Pick<Console, 'log' | 'info' | 'warn' | 'error'>;

let buffer: string[] = [];
let hardStopMessage: string | null = null;
let flushed = false;
let outputObserver: ((chunk: string) => void) | null = null;

/** Buffer one already-formatted cliLog chunk (the trailing newline is included). */
export function bufferOutput(chunk: string): void {
  buffer.push(chunk);
  outputObserver?.(chunk);
}

/**
 * PiArc: observe every buffered chunk as it arrives (null stops). The flushed output
 * stays authoritative: it still drops business output after a hard stop.
 */
export function observeOutput(observer: ((chunk: string) => void) | null): void {
  outputObserver = observer;
}

/** Create the console object injected into one agent round. */
export function createRoundConsole(writeLine: (line: string) => void = bufferOutput): RoundConsole {
  const append = (prefix: string, args: unknown[]) => {
    const body = args.map(formatCliLogValue).join(' ');
    writeLine(`${prefix}${body}\n`);
  };
  return Object.freeze({
    log: (...args: unknown[]) => {
      append('', args);
    },
    info: (...args: unknown[]) => {
      append('', args);
    },
    warn: (...args: unknown[]) => {
      append('[warn] ', args);
    },
    error: (...args: unknown[]) => {
      append('[error] ', args);
    },
  });
}

/**
 * Record the owned message of the first hard-stop error seen this run. Later hard stops
 * — the same error re-reported on each loop iteration — are ignored so the agent sees
 * the guidance exactly once.
 */
export function markHardStop(message: string): void {
  hardStopMessage ??= message;
}

/**
 * Emit the run's output exactly once.
 *
 * `thrown` separates a completed script from one ending on an uncaught error. On a clean
 * finish we are the only writer, so a hard stop must print its message here. On an
 * uncaught error the propagating Error already surfaces the message (the host prints it),
 * so we stay silent and only drop the buffer. Non-hard-stop output is flushed either way,
 * so an ordinary failure still shows what the script logged before it threw.
 */
export function flushSink(stream: WritableLike, thrown: boolean): void {
  if (flushed) return;
  flushed = true;
  const pageNotices = consumeUnhandledPageNotices();
  if (hardStopMessage !== null) {
    // Drop every buffered line — business logs, success rows, and the repeated error
    // echoes — so the owned guidance is all that remains.
    if (!thrown) {
      stream.write(hardStopMessage.endsWith('\n') ? hardStopMessage : `${hardStopMessage}\n`);
    }
  } else {
    for (const chunk of buffer) stream.write(chunk);
    if (pageNotices.length > 0) {
      stream.write(formatPageNotices(pageNotices));
    }
  }
  buffer = [];
}

/** Clear sink state at the start of a run. */
export function resetSink(): void {
  buffer = [];
  hardStopMessage = null;
  flushed = false;
  resetPageNotices();
}

function formatPageNotices(notices: UnhandledPageNotice[]): string {
  const lines = notices.map((notice) => {
    const source = notice.openerLabel ? ` from ${notice.openerLabel}` : '';
    const url = oneLine(notice.url === undefined || notice.url === '' ? 'about:blank' : notice.url);
    return `Unhandled page ${notice.label}${source}: ${url}`;
  });
  return `[ego-browser:pages]\n${lines.join('\n')}\n`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
