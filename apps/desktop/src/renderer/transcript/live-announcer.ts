// The throttle of the conversation's live region (T43, `LIVE_ANNOUNCE`): progress text is
// published at most once per interval (the latest text, at the end of the interval), and the
// same text is not published twice in a row; a result is published at once and drops the
// progress still waiting. Time comes from an injected clock, so tests count publications.
import { LIVE_ANNOUNCE } from './constants.js';

export interface AnnouncerClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const WINDOW_CLOCK: AnnouncerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class ThrottledAnnouncer {
  #published: string | undefined;
  #checkedAt = Number.NEGATIVE_INFINITY;
  #waiting: (() => string) | undefined;
  #timer: unknown;

  constructor(
    private readonly publish: (text: string) => void,
    private readonly clock: AnnouncerClock = WINDOW_CLOCK,
    private readonly intervalMs: number = LIVE_ANNOUNCE.intervalMs,
  ) {}

  /** What the agent is doing now; published when the interval allows. */
  progress(read: () => string): void {
    this.#waiting = read;
    if (this.#timer !== undefined) return;
    const due = this.#checkedAt + this.intervalMs - this.clock.now();
    if (due <= 0) {
      this.#flush();
    } else {
      this.#timer = this.clock.setTimeout(() => {
        this.#timer = undefined;
        this.#flush();
      }, due);
    }
  }

  /** The turn's result: published now; waiting progress is dropped. */
  result(text: string): void {
    this.#cancel();
    this.#waiting = undefined;
    this.#emit(text);
  }

  dispose(): void {
    this.#waiting = undefined;
    this.#cancel();
  }

  #flush(): void {
    const read = this.#waiting;
    this.#waiting = undefined;
    if (read === undefined) return;
    const text = read();
    if (text === this.#published) {
      this.#checkedAt = this.clock.now();
    } else {
      this.#emit(text);
    }
  }

  #emit(text: string): void {
    this.#published = text;
    this.#checkedAt = this.clock.now();
    this.publish(text);
  }

  #cancel(): void {
    if (this.#timer !== undefined) this.clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
