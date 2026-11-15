// The terminal prototype page (renderer, `#/terminal-lab`, T10) and what it exposes to L4 tests
// and the S7 benchmark as `window.__piarcTerminalLab`. Test-only: no product feature uses it.

/** Hash that opens the prototype page. With `?manual` the page starts no shell of its own. */
export const TERMINAL_LAB_HASH = '#/terminal-lab';

/** Counters of the page's frame loop since the last `resetStats`. */
export interface TerminalLabStats {
  /** `requestTerminalFrame` calls. */
  readonly framesRequested: number;
  /** Frames received (empty ones included). */
  readonly framesReceived: number;
  readonly emptyFrames: number;
  /** Bytes of the received frames. */
  readonly bytes: number;
  /** Time spent decoding and applying frames (ms). */
  readonly decodeMs: number;
  /** Time spent drawing frames (ms). */
  readonly renderMs: number;
  /** Longest decode + draw of one frame (ms). */
  readonly maxFrameWorkMs: number;
  /** Request-to-arrival time of each pulled frame (ms): total and longest. */
  readonly pullRoundTripMs: number;
  readonly maxPullRoundTripMs: number;
  /** Frames Core failed or the page could not apply. */
  readonly errors: number;
  /** RESET frames applied. */
  readonly resets: number;
}

export interface CellRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TerminalLabApi {
  /** Shows terminal `id` (one this window owns) and pulls a RESET frame. */
  attach(id: number): void;
  /** The shown terminal, or null. */
  terminalId(): number | null;
  /** Hides (`display: none`) or shows the terminal; a hidden terminal pulls no frames. */
  setHidden(hidden: boolean): void;
  stats(): TerminalLabStats;
  resetStats(): void;
  /** The screen rebuilt from frames, as plain text (formatter rules). */
  screenText(): string;
  /** The cursor position in cells (column, row) of the screen rebuilt from frames. */
  cursorCell(): { readonly x: number; readonly y: number };
  /** The cursor cell in viewport coordinates of the page (CSS pixels). */
  cursorRect(): CellRect;
  /** The hidden textarea that receives keys and input-method text, in page coordinates. */
  textareaRect(): CellRect;
  /** The input-method preedit text currently drawn at the cursor. */
  preedit(): string;
  /** Focuses the hidden textarea. */
  focus(): void;
  /** Resizes the terminal, keeping the cell size. */
  resize(cols: number, rows: number): void;
  /**
   * Arms an echo measurement: the next `keydown` of `char` starts the clock (its event
   * timestamp), which stops when a frame showing `char` in the cursor cell of arming time has
   * been decoded and applied. Read the result with `echoResult`.
   */
  armEcho(char: string): void;
  /** Milliseconds of the armed echo measurement, once the echo arrived. */
  echoResult(): Promise<number>;
}

declare global {
  /** Present on the terminal prototype page only (src/renderer/terminal/TerminalLab.tsx). */
  var __piarcTerminalLab: TerminalLabApi | undefined;
}
