// One terminal view (ADR-0017, T10 prototype): a canvas drawn by the forked CanvasRenderer from
// frames pulled from Core, and a hidden textarea that follows the cursor and receives keys and
// input-method text.
//
// Frame loop: each animation frame, a visible terminal with no request in flight asks Core for
// one frame; a hidden terminal (`display: none`, off screen, or a hidden page) asks for
// nothing. After the person types, the view pulls back to back until the echo arrives (at most
// EAGER_MS), so echo latency is not quantized to the display's frame interval.
import type { PiarcApi, TerminalFrameMessage } from '../../shared/ipc.js';
import type { CellRect, TerminalLabStats } from '../../shared/terminal-lab.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { decodeFrame } from './frame/decoder.js';
import { Screen } from './frame/screen.js';
import { keyMessage } from './keys.js';
import { RemoteRenderable } from './remote-renderable.js';
import { CanvasRenderer } from './vendor/ghostty-web/renderer.js';

/** How long after input the view pulls back to back while waiting for the echo. */
export const EAGER_MS = 50;

export const TERMINAL_FONT = {
  size: 14,
  family: "Menlo, Monaco, 'SF Mono', Consolas, 'DejaVu Sans Mono', monospace",
} as const;

export type TerminalViewApi = Pick<
  PiarcApi,
  'requestTerminalFrame' | 'onTerminalFrame' | 'terminalKey' | 'terminalInput' | 'terminalResize'
>;

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
  #composing = false;
  #stats = emptyStats();
  #echo: EchoProbe | null = null;
  readonly #observer: IntersectionObserver;
  readonly #listeners: [EventTarget, string, EventListener][] = [];

  constructor(host: HTMLElement, api: TerminalViewApi) {
    this.#api = api;
    host.style.position = 'relative';
    this.#canvas = document.createElement('canvas');
    this.#canvas.setAttribute('data-testid', 'terminal-canvas');
    this.#textarea = document.createElement('textarea');
    this.#textarea.setAttribute('aria-label', 'Terminal input');
    this.#textarea.setAttribute('data-testid', 'terminal-input');
    this.#textarea.autocapitalize = 'off';
    this.#textarea.spellcheck = false;
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
      fontFamily: TERMINAL_FONT.family,
      fontSize: `${String(TERMINAL_FONT.size)}px`,
    });
    host.append(this.#canvas, this.#textarea);
    this.#renderer = new CanvasRenderer(this.#canvas, {
      fontSize: TERMINAL_FONT.size,
      fontFamily: TERMINAL_FONT.family,
    });
    this.#sizeTextarea();
    this.#observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      this.#onScreen = last?.isIntersecting ?? false;
    });
    this.#observer.observe(host);
    this.#listen(host, 'mousedown', () => {
      // Keep the focus in the textarea; the canvas itself takes no input.
      requestAnimationFrame(() => {
        this.#textarea.focus();
      });
    });
    this.#listen(this.#textarea, 'keydown', (event) => {
      this.#onKey(event);
    });
    this.#listen(this.#textarea, 'keyup', (event) => {
      this.#onKey(event);
    });
    this.#listen(this.#textarea, 'compositionstart', () => {
      this.#composing = true;
    });
    this.#listen(this.#textarea, 'compositionupdate', (event) => {
      this.#setPreedit(event instanceof CompositionEvent ? event.data : '');
    });
    this.#listen(this.#textarea, 'compositionend', (event) => {
      this.#composing = false;
      this.#setPreedit('');
      this.#textarea.value = '';
      const text = event instanceof CompositionEvent ? event.data : '';
      if (text !== '') {
        this.#send((id) => this.#api.terminalInput(id, text));
      }
    });
    this.#listen(this.#textarea, 'input', (event) => {
      // Text that arrived without a key event the view handled (emoji picker, paste).
      const composing = event instanceof InputEvent && event.isComposing;
      if (this.#composing || composing || this.#textarea.value === '') {
        return;
      }
      const text = this.#textarea.value;
      this.#textarea.value = '';
      this.#send((id) => this.#api.terminalInput(id, text));
    });
    this.#raf = requestAnimationFrame(this.#tick);
  }

  #listen(target: EventTarget, type: string, listener: (event: Event) => void): void {
    target.addEventListener(type, listener);
    this.#listeners.push([target, type, listener]);
  }

  /** Shows terminal `id`; the first frame resets the screen. */
  attach(id: number): void {
    if (this.#id !== null) {
      void this.#api.onTerminalFrame(this.#id, undefined);
    }
    this.#id = id;
    this.#screen = new Screen();
    this.#remote = new RemoteRenderable(this.#screen);
    this.#needFull = true;
    this.#inFlight = false;
    this.#api.onTerminalFrame(id, this.#onFrame).catch((error: unknown) => {
      console.error('[terminal] cannot receive frames', error);
    });
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
    return { width: this.#renderer.charWidth, height: this.#renderer.charHeight };
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

  resize(cols: number, rows: number): void {
    if (this.#id === null) {
      return;
    }
    const { width, height } = this.cell;
    this.#api
      .terminalResize(this.#id, { cols, rows, cellWidth: width, cellHeight: height })
      .catch((error: unknown) => {
        console.error('[terminal] resize failed', error);
      });
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
    this.#observer.disconnect();
    for (const [target, type, listener] of this.#listeners) {
      target.removeEventListener(type, listener);
    }
    if (this.#id !== null) {
      void this.#api.onTerminalFrame(this.#id, undefined);
    }
    this.#canvas.remove();
    this.#textarea.remove();
  }

  #visible(): boolean {
    return this.#onScreen && document.visibilityState === 'visible';
  }

  readonly #tick = (): void => {
    this.#raf = requestAnimationFrame(this.#tick);
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
    this.#api.requestTerminalFrame(id, this.#needFull).catch((error: unknown) => {
      this.#inFlight = false;
      this.#needFull = true;
      this.#stats.errors += 1;
      console.error('[terminal] frame request failed', error);
    });
  }

  readonly #onFrame = (message: TerminalFrameMessage): void => {
    if (message.terminalId !== this.#id) {
      return;
    }
    this.#inFlight = false;
    const roundTrip = performance.now() - this.#requestedAt;
    this.#stats.pullRoundTripMs += roundTrip;
    this.#stats.maxPullRoundTripMs = Math.max(this.#stats.maxPullRoundTripMs, roundTrip);
    if (message.frame === undefined) {
      this.#stats.errors += 1;
      this.#needFull = true;
      return;
    }
    const started = performance.now();
    let empty: boolean;
    try {
      const frame = decodeFrame(message.frame);
      const change = this.#screen.apply(frame);
      if (frame.reset) {
        this.#needFull = false;
        this.#stats.resets += 1;
      }
      empty = frame.body === null;
      this.#stats.framesReceived += 1;
      this.#stats.bytes += message.frame.byteLength;
      if (empty) {
        this.#stats.emptyFrames += 1;
      } else {
        this.#remote.noteChange(change);
      }
    } catch (error) {
      this.#stats.errors += 1;
      this.#needFull = true;
      console.error('[terminal] dropped a frame', error);
      return;
    }
    const decoded = performance.now();
    this.#stats.decodeMs += decoded - started;
    this.#checkEcho(decoded);
    if (!empty) {
      this.#renderer.render(this.#remote);
      this.#sizeTextarea();
      this.#eagerUntil = 0;
    }
    const finished = performance.now();
    this.#stats.renderMs += finished - decoded;
    this.#stats.maxFrameWorkMs = Math.max(this.#stats.maxFrameWorkMs, finished - started);
    if (finished < this.#eagerUntil) {
      this.#request();
    }
  };

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

  #onKey(event: Event): void {
    if (!(event instanceof KeyboardEvent) || this.#id === null) {
      return;
    }
    if (isImeComposing(event, this.#composing)) {
      return;
    }
    const message = keyMessage(event);
    if (message === undefined) {
      return;
    }
    if (event.type === 'keydown') {
      event.preventDefault();
      const probe = this.#echo;
      if (probe !== null && probe.startedAt === null && event.key === probe.char) {
        probe.startedAt = event.timeStamp;
      }
    }
    this.#send((id) => this.#api.terminalKey(id, message));
  }

  /** Sends input to the terminal, then pulls eagerly until the echo arrives. */
  #send(call: (id: number) => Promise<void>): void {
    const id = this.#id;
    if (id === null) {
      return;
    }
    call(id).catch((error: unknown) => {
      console.error('[terminal] input failed', error);
    });
    // Pull until the echo shows up instead of waiting for the next animation frame.
    this.#eagerUntil = performance.now() + EAGER_MS;
    this.#request();
  }

  #setPreedit(text: string): void {
    this.#remote.setPreedit(text);
    if (this.#screen.rows > 0) {
      this.#renderer.render(this.#remote);
    }
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
    });
  }
}
