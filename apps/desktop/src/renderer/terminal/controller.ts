// One terminal view (ADR-0017, T10, T34): a canvas drawn by the forked CanvasRenderer from
// frames pulled from Core, and a hidden textarea that follows the cursor and receives keys and
// input-method text. Keyboard, input method, paste and copy are in `input.ts`; pointer,
// wheel and links in `pointer.ts`.
//
// Frame loop: while the terminal is visible and something may have changed, each animation
// frame asks Core for one frame, which comes back as the reply to the request (ADR-0023).
// After `PARK_AFTER` empty frames in a row the next request parks: if it is empty too the view
// stops asking, and Core sends `output` on `term/<id>` when the terminal changes (`wake`).
// Input, resizing, scrolling and focus wake the view as well. A hidden view (`display: none`,
// off screen, a hidden or minimized window) schedules nothing and asks for nothing; an idle one
// runs no animation frames at all. After the person types, the view pulls back to back until
// the echo arrives (at most EAGER_MS), so echo latency is not quantized to the frame interval.
import type { PiarcApi, TerminalScrollTarget } from '../../shared/ipc.js';
import type { CellRect, TerminalLabStats } from '../../shared/terminal-lab.js';
import { decodeFrame } from './frame/decoder.js';
import { Screen } from './frame/screen.js';
import { attachInput, type InputHost } from './input.js';
import { attachPointer, type PointerHost } from './pointer.js';
import { RemoteRenderable, type ThemeColors } from './remote-renderable.js';
import { highlightsIn } from './search.js';
import { coreColors } from './theme.js';
import type { TerminalMatchInfo } from '../../shared/ipc.js';
import { CanvasRenderer, type Highlight } from './vendor/ghostty-web/renderer.js';

/** How long after input the view pulls back to back while waiting for the echo. */
export const EAGER_MS = 50;

/** Empty frames in a row before the view parks. */
export const PARK_AFTER = 8;

/** Half a blink period of a blinking cursor. */
export const BLINK_MS = 600;

/** The terminal's font size in CSS pixels; the family is the system monospace token. */
export const TERMINAL_FONT_SIZE = 13;

/** Fallback when the token cannot be read (the prototype page has no app styles). */
const FALLBACK_FAMILY = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace";

export type TerminalViewApi = Pick<
  PiarcApi,
  | 'requestTerminalFrame'
  | 'terminalKey'
  | 'terminalInput'
  | 'terminalResize'
  | 'terminalMouse'
  | 'terminalFocus'
  | 'terminalPaste'
  | 'terminalScroll'
  | 'terminalColors'
  | 'terminalSelectionText'
  | 'terminalClearSelection'
  | 'terminalLinkAt'
>;

/** What the owner of a view decides. */
export interface TerminalViewOptions {
  /** `mac` (⌘ is Mod) or `other` (Ctrl is Mod). */
  readonly platform: 'mac' | 'other';
  /** True for keys the app keeps while the terminal has the focus (global shortcuts). */
  readonly isGlobalKey: (event: KeyboardEvent) => boolean;
  /** Accessible name of the terminal's input. */
  readonly label: string;
  /** Fit the grid to the host element (the panel); otherwise `resize` sets it (prototype). */
  readonly fit: boolean;
  /** Open a link the person clicked (the owner shows its address and asks first). */
  readonly openLink?: (uri: string) => void;
  /** Text that could run commands by itself is about to be pasted; resolve true to paste. */
  readonly confirmPaste?: (text: string) => Promise<boolean>;
  /** The selected text was copied (for an announcement). */
  readonly copied?: () => void;
}

type MutableStats = { -readonly [K in keyof TerminalLabStats]: TerminalLabStats[K] };

function emptyStats(): MutableStats {
  return {
    framesRequested: 0,
    framesReceived: 0,
    emptyFrames: 0,
    bytes: 0,
    decodeMs: 0,
    renderMs: 0,
    maxFrameWorkMs: 0,
    pullRoundTripMs: 0,
    maxPullRoundTripMs: 0,
    errors: 0,
    resets: 0,
  };
}

interface EchoProbe {
  readonly char: string;
  readonly x: number;
  readonly y: number;
  startedAt: number | null;
  readonly resolve: (ms: number) => void;
}

export class TerminalController {
  readonly #api: TerminalViewApi;
  readonly #options: TerminalViewOptions;
  readonly #host: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #textarea: HTMLTextAreaElement;
  readonly #renderer: CanvasRenderer;
  #screen = new Screen();
  #remote = new RemoteRenderable(this.#screen);
  #id: number | null = null;
  #raf = 0;
  #inFlight = false;
  #requestedAt = 0;
  #needFull = true;
  #onScreen = false;
  #eagerUntil = 0;
  #emptyStreak = 0;
  #parked = false;
  #stats = emptyStats();
  #echo: EchoProbe | null = null;
  #matches: readonly TerminalMatchInfo[] = [];
  #currentMatch: number | undefined;
  #reducedMotion = false;
  #blink = 0;
  /** The blink phase: true while a blinking cursor is hidden. */
  #blinkOff = false;
  #focused = false;
  #size: { cols: number; rows: number } | null = null;
  readonly #cleanups: (() => void)[] = [];

  constructor(host: HTMLElement, api: TerminalViewApi, options: TerminalViewOptions) {
    this.#api = api;
    this.#options = options;
    this.#host = host;
    host.style.position = 'relative';
    this.#canvas = document.createElement('canvas');
    this.#canvas.setAttribute('data-testid', 'terminal-canvas');
    this.#canvas.setAttribute('aria-hidden', 'true');
    this.#textarea = document.createElement('textarea');
    this.#textarea.setAttribute('aria-label', options.label);
    this.#textarea.setAttribute('data-testid', 'terminal-input');
    this.#textarea.autocapitalize = 'off';
    this.#textarea.spellcheck = false;
    host.append(this.#canvas, this.#textarea);
    const family = getComputedStyle(host).getPropertyValue('--piarc-font-mono').trim();
    // Invisible, on the cursor cell: the input method places its candidates there.
    Object.assign(this.#textarea.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      padding: '0',
      margin: '0',
      border: '0',
      outline: 'none',
      resize: 'none',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      opacity: '0',
      color: 'transparent',
      background: 'transparent',
      caretColor: 'transparent',
      fontFamily: family === '' ? FALLBACK_FAMILY : family,
    });
    this.#renderer = new CanvasRenderer(this.#canvas, {
      fontSize: TERMINAL_FONT_SIZE,
      fontFamily: family === '' ? FALLBACK_FAMILY : family,
      devicePixelRatio: window.devicePixelRatio,
    });
    this.#sizeTextarea();
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      this.#onScreen = last?.isIntersecting ?? false;
      this.#schedule();
    });
    observer.observe(host);
    this.#cleanups.push(() => {
      observer.disconnect();
    });
    this.#listen(document, 'visibilitychange', () => {
      this.#schedule();
    });
    this.#watchRatio();
    if (options.fit) {
      const resize = new ResizeObserver(() => {
        this.#fit();
      });
      resize.observe(host);
      this.#cleanups.push(() => {
        resize.disconnect();
      });
    }
    this.#cleanups.push(attachInput(this.#inputHost(), this.#textarea));
    this.#cleanups.push(attachPointer(this.#pointerHost(), this.#canvas));
    this.#listen(this.#textarea, 'focus', () => {
      this.#setFocused(true);
    });
    this.#listen(this.#textarea, 'blur', () => {
      this.#setFocused(false);
    });
  }

  #listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener);
    this.#cleanups.push(() => {
      target.removeEventListener(type, listener);
    });
  }

  /** Shows terminal `id`; the first frame resets the screen. */
  attach(id: number): void {
    this.#id = id;
    const theme = this.#remote.theme;
    this.#screen = new Screen();
    this.#remote = new RemoteRenderable(this.#screen);
    this.#remote.setTheme(theme);
    this.#remote.setFocused(this.#focused);
    this.#needFull = true;
    this.#inFlight = false;
    this.#size = null;
    this.#matches = [];
    this.#currentMatch = undefined;
    this.#api.terminalColors(id, coreColors(theme)).catch(() => undefined);
    if (this.#options.fit) {
      this.#fit();
    }
    this.wake();
  }

  get terminalId(): number | null {
    return this.#id;
  }

  get screen(): Screen {
    return this.#screen;
  }

  get preedit(): string {
    return this.#remote.preedit;
  }

  /** Cell size in CSS pixels. */
  get cell(): { width: number; height: number } {
    const ratio = this.#renderer.pixelRatio;
    return { width: this.#renderer.charWidth / ratio, height: this.#renderer.charHeight / ratio };
  }

  /** Cell size in device pixels (what Core gets for pixel reports and pointer positions). */
  get deviceCell(): { width: number; height: number } {
    return { width: this.#renderer.charWidth, height: this.#renderer.charHeight };
  }

  /** Whether the visible rows show a selection. */
  hasSelection(): boolean {
    for (let y = 0; y < this.#screen.rows; y += 1) {
      if (this.#screen.selection(y) !== null) return true;
    }
    return false;
  }

  stats(): TerminalLabStats {
    return { ...this.#stats };
  }

  resetStats(): void {
    this.#stats = emptyStats();
  }

  focus(): void {
    this.#textarea.focus();
  }

  /** The theme's colors (design tokens); Core gets the defaults so programs see them too. */
  setTheme(theme: ThemeColors): void {
    this.#remote.setTheme(theme);
    if (this.#id !== null) {
      this.#api.terminalColors(this.#id, coreColors(theme)).catch(() => undefined);
    }
    this.#draw();
    this.wake();
  }

  /** The accessible name of the terminal's input (a renamed tab). */
  setLabel(label: string): void {
    this.#textarea.setAttribute('aria-label', label);
  }

  /** Stops the cursor blinking (`prefers-reduced-motion`, the app's setting). */
  setReducedMotion(reduced: boolean): void {
    this.#reducedMotion = reduced;
    this.#updateBlink();
  }

  /** Sets the grid (the prototype page; the panel fits the host instead). */
  resize(cols: number, rows: number): void {
    this.#resizeTo(cols, rows);
  }

  /** New output (Core's `output` event): pull again. */
  wake(): void {
    this.#parked = false;
    this.#emptyStreak = 0;
    this.#schedule();
  }

  /** Find-bar matches to highlight; `current` is the one to point at. */
  setMatches(matches: readonly TerminalMatchInfo[], current: number | undefined): void {
    this.#matches = matches;
    this.#currentMatch = current;
    this.#applyHighlights();
    this.#draw();
  }

  /** Moves the viewport. */
  scroll(to: TerminalScrollTarget): void {
    this.#call((id) => this.#api.terminalScroll(id, to));
  }

  /** The viewport's place in the scrollback. */
  get viewport(): { offset: number; rows: number; cols: number } {
    const bar = this.#screen.scrollbar;
    return { offset: bar.offset, rows: this.#screen.rows, cols: this.#screen.cols };
  }

  /** Copies the selection to the clipboard; resolves the text ('' when nothing is selected). */
  async copySelection(): Promise<string> {
    const id = this.#id;
    if (id === null) return '';
    const text = await this.#api.terminalSelectionText(id);
    if (text !== '') {
      await navigator.clipboard.writeText(text);
      this.#options.copied?.();
    }
    return text;
  }

  /** The selected text, '' when nothing is selected. */
  selectionText(): Promise<string> {
    return this.#id === null ? Promise.resolve('') : this.#api.terminalSelectionText(this.#id);
  }

  cursorRect(): CellRect {
    const canvas = this.#canvas.getBoundingClientRect();
    const cursor = this.#screen.cursor;
    const { width, height } = this.cell;
    return {
      left: canvas.left + cursor.x * width,
      top: canvas.top + cursor.y * height,
      width,
      height,
    };
  }

  textareaRect(): CellRect {
    const rect = this.#textarea.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  armEcho(char: string): Promise<number> {
    return new Promise((resolve) => {
      const cursor = this.#screen.cursor;
      this.#echo = { char, x: cursor.x, y: cursor.y, startedAt: null, resolve };
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    window.clearInterval(this.#blink);
    for (const cleanup of this.#cleanups.splice(0)) {
      cleanup();
    }
    this.#id = null;
    this.#canvas.remove();
    this.#textarea.remove();
  }

  #visible(): boolean {
    return this.#onScreen && document.visibilityState === 'visible';
  }

  /** Asks for an animation frame when one is due: attached, visible, not parked. */
  #schedule(): void {
    if (this.#raf !== 0 || this.#id === null || !this.#visible() || this.#parked) {
      return;
    }
    this.#raf = requestAnimationFrame(this.#tick);
  }

  readonly #tick = (): void => {
    this.#raf = 0;
    this.#request();
  };

  #request(): void {
    const id = this.#id;
    if (id === null || this.#inFlight || !this.#visible()) {
      return;
    }
    this.#inFlight = true;
    this.#requestedAt = performance.now();
    this.#stats.framesRequested += 1;
    const park = this.#emptyStreak >= PARK_AFTER && performance.now() >= this.#eagerUntil;
    this.#api.requestTerminalFrame(id, this.#needFull, park).then(
      (frame) => {
        this.#onFrame(id, frame, park);
      },
      (error: unknown) => {
        if (id !== this.#id) {
          return;
        }
        this.#inFlight = false;
        this.#needFull = true;
        this.#stats.errors += 1;
        console.error('[terminal] frame request failed', error);
        this.#schedule();
      },
    );
  }

  #onFrame(id: number, frame: Uint8Array, parked: boolean): void {
    if (id !== this.#id) {
      // The view switched terminals while the request was in flight.
      return;
    }
    this.#inFlight = false;
    const roundTrip = performance.now() - this.#requestedAt;
    this.#stats.pullRoundTripMs += roundTrip;
    this.#stats.maxPullRoundTripMs = Math.max(this.#stats.maxPullRoundTripMs, roundTrip);
    const started = performance.now();
    let empty: boolean;
    let held: boolean;
    try {
      const decoded = decodeFrame(frame);
      const scrolled = decoded.body?.scrollbar.offset !== this.#screen.scrollbar.offset;
      const change = this.#screen.apply(decoded);
      if (decoded.reset) {
        this.#needFull = false;
        this.#stats.resets += 1;
      }
      empty = decoded.body === null;
      held = decoded.held;
      this.#stats.framesReceived += 1;
      this.#stats.bytes += frame.byteLength;
      if (empty) {
        this.#stats.emptyFrames += 1;
      } else {
        this.#remote.noteChange(change);
        if (scrolled || change.full) this.#applyHighlights();
      }
    } catch (error) {
      this.#stats.errors += 1;
      this.#needFull = true;
      console.error('[terminal] dropped a frame', error);
      this.#schedule();
      return;
    }
    const decodedAt = performance.now();
    this.#stats.decodeMs += decodedAt - started;
    this.#checkEcho(decodedAt);
    if (!empty) {
      this.#draw();
      this.#updateBlink();
      this.#eagerUntil = 0;
    }
    const finished = performance.now();
    this.#stats.renderMs += finished - decodedAt;
    this.#stats.maxFrameWorkMs = Math.max(this.#stats.maxFrameWorkMs, finished - started);
    this.#emptyStreak = empty && !held ? this.#emptyStreak + 1 : 0;
    if (empty && parked && !held) {
      // Core wakes the view (`output`) when the terminal changes.
      this.#parked = true;
      return;
    }
    if (finished < this.#eagerUntil) {
      this.#request();
    } else {
      this.#schedule();
    }
  }

  #draw(): void {
    if (this.#screen.rows > 0) {
      this.#renderer.render(this.#remote);
      this.#sizeTextarea();
    }
  }

  #applyHighlights(): void {
    const highlights: Map<number, Highlight[]> =
      this.#matches.length === 0
        ? new Map<number, Highlight[]>()
        : highlightsIn(this.#matches, this.#currentMatch, this.viewport);
    this.#remote.setHighlights(highlights);
  }

  #checkEcho(at: number): void {
    const probe = this.#echo;
    const startedAt = probe?.startedAt ?? null;
    if (probe === null || startedAt === null) {
      return;
    }
    if (this.#screen.row(probe.y)[probe.x]?.text === probe.char) {
      this.#echo = null;
      probe.resolve(at - startedAt);
    }
  }

  /** Runs a Core call for the attached terminal, then pulls for its effect. */
  #call(call: (id: number) => Promise<unknown>, eager = false): void {
    const id = this.#id;
    if (id === null) {
      return;
    }
    call(id).catch((error: unknown) => {
      console.error('[terminal] call failed', error);
    });
    if (eager) {
      // Pull until the echo shows up instead of waiting for the next animation frame.
      this.#eagerUntil = performance.now() + EAGER_MS;
      this.#parked = false;
      this.#emptyStreak = 0;
      this.#request();
    } else {
      this.wake();
    }
  }

  #setFocused(focused: boolean): void {
    this.#focused = focused;
    this.#remote.setFocused(focused);
    this.#blinkOff = false;
    this.#remote.setBlinkHidden(false);
    this.#updateBlink();
    this.#draw();
    this.#call((id) => this.#api.terminalFocus(id, focused));
  }

  /** Runs the blink timer only while it shows something: focused, blinking, motion allowed. */
  #updateBlink(): void {
    const wanted = this.#focused && this.#screen.cursor.blinking && !this.#reducedMotion;
    if (wanted && this.#blink === 0) {
      this.#blink = window.setInterval(() => {
        if (!this.#visible()) return;
        this.#blinkOff = !this.#blinkOff;
        this.#remote.setBlinkHidden(this.#blinkOff);
        this.#draw();
      }, BLINK_MS);
    } else if (!wanted && this.#blink !== 0) {
      window.clearInterval(this.#blink);
      this.#blink = 0;
      this.#blinkOff = false;
      this.#remote.setBlinkHidden(false);
      this.#draw();
    }
  }

  /** Re-measures when the window moves to a screen with another pixel ratio, or zooms. */
  #watchRatio(): void {
    const query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
    const changed = () => {
      query.removeEventListener('change', changed);
      this.#renderer.setDevicePixelRatio(window.devicePixelRatio);
      this.#remote.markAll();
      if (this.#options.fit) {
        this.#size = null;
        this.#fit();
      } else if (this.#size !== null) {
        this.#resizeTo(this.#size.cols, this.#size.rows);
      }
      this.#draw();
      this.#watchRatio();
    };
    query.addEventListener('change', changed);
    this.#cleanups.push(() => {
      query.removeEventListener('change', changed);
    });
  }

  /** Sizes the grid to the host element (the panel). */
  #fit(): void {
    const { width, height } = this.cell;
    const box = this.#host.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || width <= 0 || height <= 0) {
      return;
    }
    const cols = Math.max(2, Math.min(1000, Math.floor(box.width / width)));
    const rows = Math.max(1, Math.min(1000, Math.floor(box.height / height)));
    this.#resizeTo(cols, rows);
  }

  #resizeTo(cols: number, rows: number): void {
    const id = this.#id;
    const unchanged = this.#size?.cols === cols && this.#size.rows === rows;
    this.#size = { cols, rows };
    if (id === null || unchanged) {
      return;
    }
    const cell = this.deviceCell;
    this.#call((terminal) =>
      this.#api.terminalResize(terminal, {
        cols,
        rows,
        cellWidth: Math.max(1, Math.min(256, Math.round(cell.width))),
        cellHeight: Math.max(1, Math.min(256, Math.round(cell.height))),
      }),
    );
  }

  /** Puts the textarea on the cursor cell, where the input method places its candidates. */
  #sizeTextarea(): void {
    const { width, height } = this.cell;
    const cursor = this.#screen.cursor;
    Object.assign(this.#textarea.style, {
      left: `${String(cursor.x * width)}px`,
      top: `${String(cursor.y * height)}px`,
      width: `${String(Math.max(width, 1))}px`,
      height: `${String(height)}px`,
      lineHeight: `${String(height)}px`,
      fontSize: `${String(TERMINAL_FONT_SIZE)}px`,
    });
  }

  #inputHost(): InputHost {
    return {
      platform: this.#options.platform,
      isGlobalKey: this.#options.isGlobalKey,
      attached: () => this.#id !== null,
      hasSelection: () => this.hasSelection(),
      copy: () => {
        void this.copySelection();
      },
      key: (message, event) => {
        const probe = this.#echo;
        if (
          event.type === 'keydown' &&
          probe !== null &&
          probe.startedAt === null &&
          event.key === probe.char
        ) {
          probe.startedAt = event.timeStamp;
        }
        this.#call((id) => this.#api.terminalKey(id, message), true);
      },
      text: (text) => {
        this.#call((id) => this.#api.terminalInput(id, text), true);
      },
      paste: (text) => {
        void this.#paste(text);
      },
      preedit: (text) => {
        this.#remote.setPreedit(text);
        this.#draw();
      },
    };
  }

  async #paste(text: string): Promise<void> {
    const id = this.#id;
    if (id === null || text === '') return;
    const outcome = await this.#api.terminalPaste(id, text, false);
    if (outcome === 'unsafe' && (await (this.#options.confirmPaste?.(text) ?? false))) {
      await this.#api.terminalPaste(id, text, true);
    }
    this.#call(() => Promise.resolve(), true);
  }

  #pointerHost(): PointerHost {
    return {
      platform: this.#options.platform,
      attached: () => this.#id !== null,
      ratio: () => this.#renderer.pixelRatio,
      cell: () => this.deviceCell,
      size: () => ({ cols: this.#screen.cols, rows: this.#screen.rows }),
      row: (y) => this.#screen.row(y),
      focus: () => {
        this.focus();
      },
      mouse: (event) => {
        this.#call((id) => this.#api.terminalMouse(id, event), event.action !== 'motion');
      },
      linkAt: (col, row) =>
        this.#id === null ? Promise.resolve(null) : this.#api.terminalLinkAt(this.#id, col, row),
      hover: (link) => {
        this.#remote.setHoveredLink(link);
        this.#canvas.style.cursor = link === null ? '' : 'pointer';
        this.#draw();
      },
      open: (uri) => {
        this.#options.openLink?.(uri);
      },
    };
  }
}
