// The recent audio levels of a dictation, as Core measured them (40 ms windows, up to 8 envelope
// buckets each), folded into one bar per `BAR_MS` of audio: the loudest bucket of the windows in
// that span. Kept outside React: the waveform reads it on every animation frame, the controller
// writes it on every event, and neither causes a render (addendum V-2.4).

/** Audio per bar: about two of Core's windows, so syllables read as small groups of bars. */
export const BAR_MS = 80;
/** Bars kept: about 41 s of audio, wider than any composer. */
export const MAX_BARS = 512;
/** Core's level window, in ms. */
const WINDOW_MS = 40;

export class Levels {
  /** Completed bars, oldest first; the last one may still be filling. */
  #bars: number[] = [];
  #barIndex = -1;
  #version = 0;
  #lastAudioMs = -1;
  #arrivedAt = 0;

  /** Adds a window's envelope (or its peak when the envelope is empty), measured at `audioMs`. */
  push(audioMs: number, peak: number, envelope: readonly number[], at = performance.now()): void {
    if (audioMs < this.#lastAudioMs) return;
    this.#lastAudioMs = audioMs;
    this.#arrivedAt = at;
    const value = envelope.length > 0 ? Math.max(...envelope) : peak;
    const index = Math.floor(Math.max(0, audioMs - 1) / BAR_MS);
    if (index === this.#barIndex && this.#bars.length > 0) {
      const last = this.#bars.length - 1;
      this.#bars[last] = Math.max(this.#bars[last] ?? 0, value);
    } else {
      // A gap in the audio (none in practice) reads as silence, not as a jump.
      const skipped = this.#barIndex < 0 ? 0 : Math.min(MAX_BARS, index - this.#barIndex - 1);
      for (let i = 0; i < skipped; i += 1) this.#bars.push(0);
      this.#bars.push(value);
      this.#barIndex = index;
    }
    if (this.#bars.length > MAX_BARS) this.#bars.splice(0, this.#bars.length - MAX_BARS);
    this.#version += 1;
  }

  clear(): void {
    this.#bars = [];
    this.#barIndex = -1;
    this.#lastAudioMs = -1;
    this.#arrivedAt = 0;
    this.#version += 1;
  }

  /** Increases with every change; a still picture redraws only when it moved. */
  get version(): number {
    return this.#version;
  }

  /**
   * Where the newest bar's end sits relative to the audio heard by `now`, in bars: 0 when the
   * picture ends exactly at the newest bar, negative while that bar is still filling, positive once
   * time passed without new audio. The estimate runs on the wall clock at most one window past
   * Core's last report, so the picture glides between events and stops when they stop.
   */
  drift(now: number): number {
    if (this.#barIndex < 0) return 0;
    const estimate = this.#lastAudioMs + Math.min(WINDOW_MS, Math.max(0, now - this.#arrivedAt));
    return Math.max(-1, Math.min(1, estimate / BAR_MS - (this.#barIndex + 1)));
  }

  /** The last `count` bars, oldest first, padded with silence at the start. */
  last(count: number): number[] {
    const tail = this.#bars.slice(-count);
    return tail.length >= count
      ? tail
      : [...new Array<number>(count - tail.length).fill(0), ...tail];
  }
}
