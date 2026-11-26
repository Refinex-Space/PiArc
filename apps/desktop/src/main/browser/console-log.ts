// The console of one tab (design addendum B1.4.3): the page's console messages and uncaught
// exceptions (Chromium reports both as console messages), newest 1,000 kept. Entries are
// numbered so the panel's drawer asks only for what it has not seen; the tab's state carries
// the summary. Everything here comes from the page and is shown as text.

import type { BrowserConsoleEntry, BrowserConsoleLevel } from '../../shared/browser.js';

export const CONSOLE_LIMITS = {
  entries: 1000,
  /** Characters of one message and of its source URL. */
  text: 8 * 1024,
  source: 2048,
} as const;

export interface ConsoleSummary {
  /** Sequence number of the newest entry (0 before the first). */
  readonly last: number;
  readonly count: number;
  readonly errors: number;
  readonly warnings: number;
}

/**
 * Whether a console message is one Electron itself prints in a page when it runs from its own
 * binary (development builds and L4): not the page's output, so the drawer leaves it out.
 */
export function electronNotice(text: string): boolean {
  return /^(%c)?Electron (Security|Deprecation) Warning\b/.test(text);
}

export class ConsoleLog {
  #entries: BrowserConsoleEntry[] = [];
  #seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  add(level: BrowserConsoleLevel, text: string, source: string, line: number): void {
    this.#seq += 1;
    this.#entries.push({
      seq: this.#seq,
      level,
      text: bounded(text, CONSOLE_LIMITS.text),
      source: bounded(source, CONSOLE_LIMITS.source),
      line: Number.isFinite(line) ? Math.max(0, Math.trunc(line)) : 0,
      at: this.now(),
    });
    if (this.#entries.length > CONSOLE_LIMITS.entries) {
      this.#entries = this.#entries.slice(-CONSOLE_LIMITS.entries);
    }
  }

  /** Entries newer than `seq`, oldest first. */
  after(seq: number): BrowserConsoleEntry[] {
    return this.#entries.filter((entry) => entry.seq > seq);
  }

  clear(): void {
    this.#entries = [];
  }

  summary(): ConsoleSummary {
    let errors = 0;
    let warnings = 0;
    for (const entry of this.#entries) {
      if (entry.level === 'error') errors += 1;
      else if (entry.level === 'warning') warnings += 1;
    }
    return { last: this.#seq, count: this.#entries.length, errors, warnings };
  }
}

function bounded(text: string, limit: number): string {
  const whole = text.toWellFormed();
  return whole.length > limit ? `${whole.slice(0, limit)}…` : whole;
}
