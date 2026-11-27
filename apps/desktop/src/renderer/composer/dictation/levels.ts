// The recent audio levels of a dictation, as Core measured them (40 ms windows, 8 envelope
// buckets each). Kept outside React: the waveform reads it on every animation frame, the
// controller writes it on every event, and neither causes a render (addendum V-2.4).

/** Bars kept: about 3.4 s of audio at 5 ms per bar. */
export const MAX_BARS = 640;

export class Levels {
  #bars: number[] = [];
  #version = 0;
  #lastAudioMs = 0;

  /** Adds a window's envelope (or its peak when the envelope is empty). */
  push(audioMs: number, peak: number, envelope: readonly number[]): void {
    if (audioMs < this.#lastAudioMs) return;
    this.#lastAudioMs = audioMs;
    const values = envelope.length > 0 ? envelope : [peak];
    this.#bars.push(...values);
    if (this.#bars.length > MAX_BARS) this.#bars.splice(0, this.#bars.length - MAX_BARS);
    this.#version += 1;
  }

  clear(): void {
    this.#bars = [];
    this.#lastAudioMs = 0;
    this.#version += 1;
  }

  /** Increases with every change; the waveform redraws only when it moved. */
  get version(): number {
    return this.#version;
  }

  /** The last `count` values, oldest first, padded with silence at the start. */
  last(count: number): number[] {
    const tail = this.#bars.slice(-count);
    return tail.length >= count
      ? tail
      : [...new Array<number>(count - tail.length).fill(0), ...tail];
  }
}
