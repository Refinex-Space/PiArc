// One composer's dictation (voice dictation addendum 3.2–3.5, 4.9): starts and stops the
// session through `window.piarc`, follows its events on the window's own route, and turns them
// into editor transactions (`plugin.ts`). Events of another session, or older than the last one
// seen, are dropped. While an input method composes, nothing is dispatched; what arrived is
// applied when the composition ends. The send path stops first and waits for the base text
// (bounded), so the message is the editor's state after the last segment landed.
import type { EditorView } from 'prosemirror-view';

import { Levels } from './levels.js';
import { parseDictationBatch, type DictationEventMessage } from './protocol.js';
import {
  beginTransaction,
  cancelTransaction,
  closeGroupTransaction,
  commitTransaction,
  dictationState,
  endTransaction,
  partialTransaction,
} from './plugin.js';

/** What the composer shows. */
export type DictationUi =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'preparing'; readonly since: number }
  | { readonly kind: 'recording'; readonly since: number }
  | { readonly kind: 'finalizing' }
  | { readonly kind: 'error'; readonly code: string };

/** The `window.piarc` part a controller uses (tests pass a fake). */
export interface DictationApi {
  start: (request: {
    composer: string;
    workspace?: string;
  }) => Promise<{ sessionId: string; route: string }>;
  stop: (sessionId: string, mode: 'keep' | 'send') => Promise<void>;
  cancel: (sessionId: string) => Promise<void>;
  route: () => Promise<string>;
  subscribe: (route: string, listener: (payload: unknown) => void) => () => void;
  now: () => number;
}

export interface DictationCallbacks {
  /** The UI state changed. */
  state(ui: DictationUi): void;
  /** A short notice (`maxDuration`, `noSpeech`, `refineTimeout`, `kept`…). */
  notice(code: string): void;
  /** A final segment's text, for the screen reader's polite live region. */
  announce(text: string): void;
}

/** How long sending waits for the last segment before giving up (addendum V-4.3). */
export const SEND_WAIT_MS = 3000;

const TERMINAL = new Set(['completed', 'cancelled', 'error']);

export class DictationController {
  readonly levels = new Levels();
  #ui: DictationUi = { kind: 'idle' };
  #session: string | undefined;
  #sequence = 0;
  #route: string | undefined;
  #unsubscribe: (() => void) | undefined;
  #queued: (() => void)[] = [];
  #ended: ((state: string) => void)[] = [];
  #sending: Promise<boolean> | undefined;
  #composition: (() => void) | undefined;
  /** Events that arrived while the start's answer (the session id) was on its way. */
  #early: DictationEventMessage[] = [];
  /** Cancelled before the start answered: the session it answers with is ended at once. */
  #startCancelled = false;

  constructor(
    private readonly view: () => EditorView | null,
    private readonly api: DictationApi,
    private readonly callbacks: DictationCallbacks,
    private readonly composer: string,
    private readonly workspace: () => string | undefined,
  ) {}

  get ui(): DictationUi {
    return this.#ui;
  }

  /** Whether a session is preparing, recording or finishing. */
  get active(): boolean {
    return (
      this.#ui.kind === 'starting' ||
      this.#ui.kind === 'preparing' ||
      this.#ui.kind === 'recording' ||
      this.#ui.kind === 'finalizing'
    );
  }

  #set(ui: DictationUi): void {
    this.#ui = ui;
    this.callbacks.state(ui);
  }

  /** Subscribes to the window's dictation route (once; before any start). */
  async attach(): Promise<void> {
    if (this.#unsubscribe !== undefined) return;
    this.#route ??= await this.api.route();
    this.#unsubscribe = this.api.subscribe(this.#route, (payload) => {
      for (const event of parseDictationBatch(payload)) this.#receive(event);
    });
    const dom = this.view()?.dom;
    if (dom !== undefined) {
      const flush = () => {
        // ProseMirror ends its own composition handling in the same event; apply after it.
        queueMicrotask(() => {
          this.#flush();
        });
      };
      dom.addEventListener('compositionend', flush);
      this.#composition = () => {
        dom.removeEventListener('compositionend', flush);
      };
    }
  }

  /**
   * Starts dictating at the editor's selection end; `levelsOnly` is the settings page's
   * microphone test (no editor, no text).
   */
  async start(levelsOnly = false): Promise<void> {
    const view = this.view();
    if ((view === null && !levelsOnly) || this.active) return;
    this.#set({ kind: 'starting' });
    this.#early = [];
    this.#startCancelled = false;
    this.levels.clear();
    try {
      await this.attach();
      const workspace = this.workspace();
      const started = await this.api.start({
        composer: this.composer,
        ...(workspace === undefined ? {} : { workspace }),
      });
      if (this.#cancelledWhileStarting()) {
        // Cancelled (or sent) while the main process was asking for the microphone (V-4.4).
        this.#early = [];
        void this.api.cancel(started.sessionId).catch(() => undefined);
        return;
      }
      this.#session = started.sessionId;
      this.#sequence = 0;
      const current = this.view();
      if (current === null && !levelsOnly) {
        void this.api.cancel(started.sessionId);
        return;
      }
      current?.dispatch(beginTransaction(current.state));
      if (this.#ui.kind === 'starting') this.#set({ kind: 'preparing', since: this.api.now() });
      const early = this.#early;
      this.#early = [];
      for (const event of early) this.#receive(event);
    } catch (error: unknown) {
      this.#session = undefined;
      if (!this.#cancelledWhileStarting()) this.#set({ kind: 'error', code: codeOf(error) });
    }
  }

  /** Read through a method: a `cancel()` during the start's `await` changes it. */
  #cancelledWhileStarting(): boolean {
    return this.#startCancelled;
  }

  /** Stop (button, Escape): keep the text, nothing is sent. */
  stop(): void {
    const session = this.#session;
    if (session === undefined || !this.active) return;
    if (this.#ui.kind !== 'finalizing') this.#set({ kind: 'finalizing' });
    this.api.stop(session, 'keep').catch((error: unknown) => {
      this.#fail(codeOf(error));
    });
  }

  /** Cancel (×): removes what dictation still owns, one undo step. */
  cancel(): void {
    const session = this.#session;
    if (session === undefined && this.#ui.kind === 'starting') {
      this.#startCancelled = true;
      this.#set({ kind: 'idle' });
      return;
    }
    if (session === undefined && this.#ui.kind !== 'error') return;
    this.#apply(() => {
      const view = this.view();
      if (view === null) return;
      const { tr, kept } = cancelTransaction(view.state);
      view.dispatch(tr);
      view.dispatch(closeGroupTransaction(view.state));
      if (kept > 0) this.callbacks.notice('kept');
    });
    this.#detachSession();
    if (session !== undefined) void this.api.cancel(session).catch(() => undefined);
    this.#set({ kind: 'idle' });
  }

  /** Clears an error state. */
  dismiss(): void {
    if (this.#ui.kind === 'error') this.#set({ kind: 'idle' });
  }

  /**
   * Sending while dictating: stop, wait for the last segment's base text (at most
   * `SEND_WAIT_MS`), then answer whether the caller may send. Repeated calls share one wait.
   */
  stopForSend(): Promise<boolean> {
    if (this.#sending !== undefined) return this.#sending;
    if (this.#ui.kind === 'starting' || this.#ui.kind === 'preparing') {
      // No audio yet: the dictation is cancelled (also a start still on its way) and the
      // draft is sent as it is (V-4.4).
      this.cancel();
      return Promise.resolve(true);
    }
    const session = this.#session;
    if (session === undefined || !this.active) return Promise.resolve(true);
    this.#sending = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#sending = undefined;
        // The words on screen go out as they stand (the hypothesis becomes text); with none,
        // nothing is sent and the strip says why (V-4.3, V-4.5).
        const view = this.view();
        const partial = view === null ? null : dictationState(view.state).partial;
        const words =
          view !== null &&
          (view.state.doc.textContent.trim() !== '' || (partial?.text.trim() ?? '') !== '');
        resolve(words);
        if (words) this.#settle();
        else this.#fail('sendTimeout');
      }, SEND_WAIT_MS);
      this.#ended.push((state) => {
        clearTimeout(timer);
        this.#sending = undefined;
        resolve(state === 'completed');
      });
    });
    this.#set({ kind: 'finalizing' });
    this.api.stop(session, 'send').catch((error: unknown) => {
      this.#fail(codeOf(error));
    });
    return this.#sending;
  }

  /**
   * The document was replaced (a message given back, an external draft): the session ends and
   * nothing more is written; the hypothesis does not move into the new text (V-3.5).
   */
  abandon(): void {
    if (this.#ui.kind === 'starting' && this.#session === undefined) {
      this.cancel();
      return;
    }
    const session = this.#session;
    if (session === undefined) return;
    const view = this.view();
    if (view !== null) view.dispatch(endTransaction(view.state));
    this.#detachSession();
    void this.api.cancel(session).catch(() => undefined);
    this.#set({ kind: 'idle' });
  }

  /** Ends the session keeping what is on screen, the hypothesis written as text. */
  #settle(): void {
    const session = this.#session;
    const view = this.view();
    if (view !== null) {
      const partial = dictationState(view.state).partial;
      if (partial !== null) {
        const tr = commitTransaction(
          view.state,
          partial.segment,
          Number.MAX_SAFE_INTEGER,
          'final',
          partial.text,
        );
        if (tr !== undefined) view.dispatch(tr);
      }
      view.dispatch(endTransaction(view.state));
      view.dispatch(closeGroupTransaction(view.state));
    }
    this.#detachSession();
    if (session !== undefined) void this.api.cancel(session).catch(() => undefined);
    this.#set({ kind: 'idle' });
  }

  /** The composer goes away: the hypothesis becomes text, then the session ends. */
  detach(): void {
    const session = this.#session;
    const view = this.view();
    if (view !== null && session !== undefined) {
      const partial = dictationState(view.state).partial;
      if (partial !== null) {
        const tr = commitTransaction(
          view.state,
          partial.segment,
          Number.MAX_SAFE_INTEGER,
          'final',
          partial.text,
        );
        if (tr !== undefined) view.dispatch(tr);
      }
      view.dispatch(endTransaction(view.state));
    }
    this.#detachSession();
    if (session !== undefined) void this.api.cancel(session).catch(() => undefined);
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#composition?.();
    this.#composition = undefined;
  }

  #detachSession(): void {
    this.#session = undefined;
    this.#queued = [];
    const ended = this.#ended;
    this.#ended = [];
    for (const done of ended) done('cancelled');
  }

  #fail(code: string): void {
    const view = this.view();
    if (view !== null) {
      view.dispatch(endTransaction(view.state));
      view.dispatch(closeGroupTransaction(view.state));
    }
    this.#detachSession();
    this.#set({ kind: 'error', code });
  }

  #apply(change: () => void): void {
    const view = this.view();
    if (view?.composing === true) {
      this.#queued.push(change);
      return;
    }
    change();
  }

  #flush(): void {
    const view = this.view();
    if (view === null || view.composing) return;
    const queued = this.#queued;
    this.#queued = [];
    for (const change of queued) change();
  }

  #receive(event: DictationEventMessage): void {
    if (this.#session === undefined && this.#ui.kind === 'starting') {
      // The engine can answer faster than the start's reply; keep a bounded backlog.
      if (this.#early.length < 256) this.#early.push(event);
      return;
    }
    if (event.sessionId !== this.#session || event.sequence <= this.#sequence) return;
    this.#sequence = event.sequence;
    switch (event.type) {
      case 'level':
        this.levels.push(event.audioMs, event.peak, event.envelope);
        return;
      case 'notice':
        this.callbacks.notice(event.code);
        return;
      case 'text':
        this.#text(event.segmentId, event.revision, event.stage, event.text);
        return;
      case 'state':
        this.#state(event.state, event.code);
        return;
    }
  }

  #text(
    segment: number,
    revision: number,
    stage: 'partial' | 'provisional' | 'final',
    text: string,
  ): void {
    this.#apply(() => {
      const view = this.view();
      if (view === null) return;
      if (stage === 'partial') {
        view.dispatch(partialTransaction(view.state, segment, revision, text));
        return;
      }
      const tr = commitTransaction(view.state, segment, revision, stage, text);
      if (tr === undefined) return;
      view.dispatch(tr);
      view.dispatch(closeGroupTransaction(view.state));
      if (stage === 'final' && text.trim() !== '') this.callbacks.announce(text.trim());
    });
  }

  #state(state: string, code: string | undefined): void {
    switch (state) {
      case 'preparing':
        if (this.#ui.kind === 'starting') this.#set({ kind: 'preparing', since: this.api.now() });
        return;
      case 'recording':
        this.#set({ kind: 'recording', since: this.api.now() });
        return;
      case 'finalizing':
        if (this.#ui.kind !== 'finalizing') this.#set({ kind: 'finalizing' });
        return;
      default:
        break;
    }
    if (!TERMINAL.has(state)) return;
    this.#apply(() => {
      const view = this.view();
      if (view === null) return;
      view.dispatch(endTransaction(view.state));
      view.dispatch(closeGroupTransaction(view.state));
    });
    const ended = this.#ended;
    this.#ended = [];
    this.#session = undefined;
    for (const done of ended) done(state);
    if (state === 'error') this.#set({ kind: 'error', code: code ?? 'unknown' });
    else this.#set({ kind: 'idle' });
  }
}

/** The speech code of a failed command (`speech:<code>` from the main process). */
export function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /speech:([A-Za-z]{1,64})/u.exec(message);
  return match?.[1] ?? 'unknown';
}
