// The terminal commands of `window.piarc` (ADR-0017, T10, T33, T34). The main process only
// checks arguments, access and limits and forwards: Core encodes keys and pointer events and
// produces frames, and each frame goes back unread as the reply to the window's pull request
// (ADR-0023), copied by structured clone like event batches (ADR-0019).
//
// Two kinds of terminals reach a window:
// - Terminals of a session (the terminal panel, the agent's terminal tasks): they belong to the
//   session, not to a page. Any window may view them, a reload re-attaches to them, and they end
//   with the session's task (closing the tab, archiving or deleting the session, quitting).
// - Terminals without a session, started by the test hooks for the prototype page: they belong
//   to the page that asked for them and close when it goes away.
//
// Typing into a terminal runs commands without Core's permission decision (architecture section
// 10.3, I51). So everything that writes to a terminal, opens one or shares one with the agent
// needs recent real user input in the asking window: Electron reports keyboard, mouse and touch
// input it delivers to the page (`input-event`); a script in the page cannot fake those. Each
// session has at most `MAX_SESSION_TERMINALS` open terminals, and a window has at most one
// frame request in flight per terminal.
import {
  IPC_CHANNELS,
  MAX_TERMINAL_PASTE,
  MAX_TERMINAL_QUERY,
  isSessionId,
  isTerminalKeyMessage,
  isTerminalMouseMessage,
  isTerminalScrollTarget,
  isTerminalSize,
  type TerminalSize,
} from '../../shared/ipc.js';
import {
  parseJson,
  terminalInfoOf,
  terminalLinkOf,
  terminalMatchesOf,
  terminalOpenedOf,
} from '../../shared/terminal-results.js';
import type { TerminalForwardStats } from '../../shared/test-hooks.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** Longest text one `terminalInput` call may write (characters). */
export const MAX_TERMINAL_INPUT = 64 * 1024;

/** How recent the window's last real input must be for terminal input to pass. */
export const INPUT_WINDOW_MS = 5000;

/** Open terminals per session the panel may start. */
export const MAX_SESSION_TERMINALS = 16;

/** Electron input event types that are a person acting (not pointer moves). */
const ACTION_INPUTS: ReadonlySet<string> = new Set([
  'rawKeyDown',
  'keyDown',
  'keyUp',
  'char',
  'mouseDown',
  'mouseUp',
  'mouseWheel',
  'contextMenu',
  'gestureScrollBegin',
  'gestureScrollUpdate',
  'gestureTap',
  'touchStart',
  'touchEnd',
  'pointerDown',
  'pointerUp',
]);

/** The Core calls this module makes; the real runtime satisfies it. */
export type TerminalCore = Pick<
  CoreRuntime,
  | 'openSessionTerminal'
  | 'setTerminalShared'
  | 'closeTerminal'
  | 'terminalInput'
  | 'terminalKey'
  | 'terminalMouse'
  | 'terminalFocus'
  | 'terminalPaste'
  | 'terminalResize'
  | 'terminalFrame'
  | 'terminalScroll'
  | 'terminalClearSelection'
  | 'terminalSelectionText'
  | 'terminalLinkAt'
  | 'terminalSearch'
  | 'terminalText'
  | 'terminalInfo'
>;

/** The fields of Electron's `did-start-navigation` details that ownership reads. */
export interface NavigationDetails {
  readonly isMainFrame: boolean;
  readonly isSameDocument: boolean;
}

/** The part of a window's `WebContents` ownership needs. */
export interface OwnerContents {
  readonly id: number;
  once(event: 'destroyed', listener: () => void): unknown;
  on(event: 'render-process-gone', listener: () => void): unknown;
  on(event: 'did-start-navigation', listener: (details: NavigationDetails) => void): unknown;
  on(event: 'input-event', listener: (event: unknown, input: { type: string }) => void): unknown;
}

/** `registerHandler` (src/main/ipc/register.ts) as this module uses it. */
export type TerminalRegistrar = (
  channel: string,
  handler: (event: { readonly sender: OwnerContents }, args: readonly unknown[]) => unknown,
) => void;

/**
 * Which window may use which terminal, the windows' last real input, and the limits. A page's
 * own terminals (prototype) close when the page goes away; session terminals stay.
 */
export class TerminalOwners {
  /** Page-owned terminal → window. */
  readonly #owners = new Map<number, number>();
  /** Session terminal → its session id. */
  readonly #sessions = new Map<number, string>();
  readonly #watched = new WeakSet<OwnerContents>();
  /** Per window, how many times its page went away: a terminal started before is stale. */
  readonly #pages = new Map<number, number>();
  /** Per window, when it last got real user input (`now()` time). */
  readonly #input = new Map<number, number>();
  /** `window:terminal` pairs with a frame request in flight. */
  readonly #pulling = new Set<string>();
  readonly #core: TerminalCore;
  readonly #now: () => number;

  constructor(core: TerminalCore, now: () => number = () => performance.now()) {
    this.#core = core;
    this.#now = now;
  }

  /**
   * Watches `contents` and returns its current page, to pass to `assign` once a terminal it
   * asked for has started (Core starts terminals off the caller's thread).
   */
  page(contents: OwnerContents): number {
    this.watch(contents);
    return this.#pages.get(contents.id) ?? 0;
  }

  /**
   * Records that `contents` owns terminal `id` and closes it when `contents` goes away. When
   * the page that asked for it (`page`) went away meanwhile, closes the terminal instead and
   * returns false: no page knows its id.
   */
  assign(id: number, contents: OwnerContents, page = this.page(contents)): boolean {
    if (page !== this.page(contents)) {
      this.#close(id);
      return false;
    }
    this.#owners.set(id, contents.id);
    return true;
  }

  /** Records a terminal of session `sessionId`: every window may use it. */
  admitSession(id: number, sessionId: string): void {
    this.#sessions.set(id, sessionId);
  }

  /** Watches the page lifecycle and the real input of `contents` (once). */
  watch(contents: OwnerContents): void {
    if (this.#watched.has(contents)) {
      return;
    }
    this.#watched.add(contents);
    const windowId = contents.id;
    contents.once('destroyed', () => {
      this.closeAllOf(windowId);
      this.#input.delete(windowId);
    });
    contents.on('render-process-gone', () => {
      this.closeAllOf(windowId);
    });
    contents.on('did-start-navigation', (details) => {
      // Hash routes are same-document; subframes do not own terminals.
      if (details.isMainFrame && !details.isSameDocument) {
        this.closeAllOf(windowId);
      }
    });
    contents.on('input-event', (_event, input) => {
      if (ACTION_INPUTS.has(input.type)) {
        this.#input.set(windowId, this.#now());
      }
    });
  }

  /** Whether window `windowId` got real user input within `INPUT_WINDOW_MS`. */
  hasRecentInput(windowId: number): boolean {
    const at = this.#input.get(windowId);
    return at !== undefined && this.#now() - at <= INPUT_WINDOW_MS;
  }

  /** Throws unless `contents` got real user input recently. */
  requireInput(contents: OwnerContents): void {
    this.watch(contents);
    if (!this.hasRecentInput(contents.id)) {
      throw new Error('Terminal input needs recent user input in this window');
    }
  }

  /** The session of terminal `id`, asking Core once for a terminal this module has not seen. */
  #sessionOf(id: number): string | undefined {
    const known = this.#sessions.get(id);
    if (known !== undefined) {
      return known;
    }
    let sessionId: string | undefined;
    try {
      sessionId = terminalInfoOf(parseJson(this.#core.terminalInfo(id)))?.sessionId;
    } catch {
      return undefined;
    }
    if (sessionId !== undefined) {
      this.#sessions.set(id, sessionId);
    }
    return sessionId;
  }

  /** `id` as a terminal id that window `windowId` may use; throws otherwise. */
  check(windowId: number, id: unknown): number {
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
      throw new TypeError('Unknown terminal');
    }
    if (this.#owners.get(id) === windowId || this.#sessionOf(id) !== undefined) {
      return id;
    }
    throw new TypeError('Unknown terminal');
  }

  /**
   * Whether window `windowId` may subscribe to `route`: a terminal's route `term/<id>` only for
   * a terminal it may use; other routes are not terminal routes and are not judged here.
   */
  mayObserve(windowId: number, route: string): boolean {
    const terminal = /^term\/(\d+)$/.exec(route);
    if (terminal === null) {
      return !route.startsWith('term/');
    }
    const id = Number(terminal[1]);
    return this.#owners.get(id) === windowId || this.#sessionOf(id) !== undefined;
  }

  /** Open terminals of `sessionId` this module knows; forgets those Core no longer has. */
  openOf(sessionId: string): number {
    let open = 0;
    for (const [id, session] of [...this.#sessions]) {
      if (session !== sessionId) continue;
      try {
        this.#core.terminalInfo(id);
        open += 1;
      } catch {
        this.#sessions.delete(id);
      }
    }
    return open;
  }

  /** Marks a frame request of `windowId` for `id` in flight; false when one already is. */
  beginPull(windowId: number, id: number): boolean {
    const key = `${String(windowId)}:${String(id)}`;
    if (this.#pulling.has(key)) {
      return false;
    }
    this.#pulling.add(key);
    return true;
  }

  endPull(windowId: number, id: number): void {
    this.#pulling.delete(`${String(windowId)}:${String(id)}`);
  }

  release(id: number): void {
    this.#owners.delete(id);
    this.#sessions.delete(id);
  }

  closeAllOf(windowId: number): void {
    this.#pages.set(windowId, (this.#pages.get(windowId) ?? 0) + 1);
    for (const key of [...this.#pulling]) {
      if (key.startsWith(`${String(windowId)}:`)) this.#pulling.delete(key);
    }
    for (const [id, owner] of [...this.#owners]) {
      if (owner !== windowId) {
        continue;
      }
      this.#owners.delete(id);
      this.#close(id);
    }
  }

  #close(id: number): void {
    try {
      this.#core.closeTerminal(id);
    } catch (error) {
      // The program may have exited and Core shut down already.
      console.warn(`[core] closing terminal ${String(id)} failed`, error);
    }
  }
}

function size(value: unknown): TerminalSize {
  if (!isTerminalSize(value)) {
    throw new TypeError('size must be { cols, rows, cellWidth, cellHeight } within limits');
  }
  return value;
}

function text(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new TypeError(`${name} must be a string of at most ${String(max)} characters`);
  }
  return value;
}

function cell(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) {
    throw new TypeError('cells are integers between 0 and 1000');
  }
  return value;
}

/** Core's JSON text checked by `check`; a malformed answer is an error, not a page value. */
async function parsed<T>(answer: Promise<string>, check: (value: unknown) => T | undefined) {
  const value = check(parseJson(await answer));
  if (value === undefined) {
    throw new Error('Core returned a malformed terminal answer');
  }
  return value;
}

/** Registers the terminal commands. `stats` counts returned frames for the test hooks. */
export function registerTerminalHandlers(
  registerHandler: TerminalRegistrar,
  core: TerminalCore,
  owners: TerminalOwners,
  stats: TerminalForwardStats,
): void {
  const use = (sender: OwnerContents, id: unknown): number => {
    owners.watch(sender);
    return owners.check(sender.id, id);
  };
  registerSessionHandlers(registerHandler, core, owners, use);
  registerInputHandlers(registerHandler, core, owners, use);
  registerViewHandlers(registerHandler, core, owners, stats, use);
}

type Use = (sender: OwnerContents, id: unknown) => number;

function registerSessionHandlers(
  registerHandler: TerminalRegistrar,
  core: TerminalCore,
  owners: TerminalOwners,
  use: Use,
): void {
  registerHandler(IPC_CHANNELS.terminalOpenSession, async (event, [sessionId, requested]) => {
    if (!isSessionId(sessionId)) {
      throw new TypeError('sessionId must be a session id');
    }
    const { cols, rows, cellWidth, cellHeight } = size(requested);
    owners.requireInput(event.sender);
    if (owners.openOf(sessionId) >= MAX_SESSION_TERMINALS) {
      throw new Error(`A session has at most ${String(MAX_SESSION_TERMINALS)} terminals`);
    }
    const opened = await parsed(
      core.openSessionTerminal(sessionId, { cols, rows, cellWidth, cellHeight }),
      terminalOpenedOf,
    );
    owners.admitSession(opened.terminalId, sessionId);
    return opened;
  });
  registerHandler(IPC_CHANNELS.terminalShare, (event, [id, shared]) => {
    const terminal = use(event.sender, id);
    if (typeof shared !== 'boolean') {
      throw new TypeError('shared must be a boolean');
    }
    owners.requireInput(event.sender);
    return core.setTerminalShared(terminal, shared);
  });
  registerHandler(IPC_CHANNELS.terminalClose, (event, [id]) => {
    const terminal = use(event.sender, id);
    owners.release(terminal);
    core.closeTerminal(terminal);
  });
}

function registerInputHandlers(
  registerHandler: TerminalRegistrar,
  core: TerminalCore,
  owners: TerminalOwners,
  use: Use,
): void {
  registerHandler(IPC_CHANNELS.terminalInput, (event, [id, input]) => {
    const terminal = use(event.sender, id);
    const value = text(input, MAX_TERMINAL_INPUT, 'text');
    owners.requireInput(event.sender);
    core.terminalInput(terminal, value);
  });
  registerHandler(IPC_CHANNELS.terminalKey, (event, [id, key]) => {
    const terminal = use(event.sender, id);
    if (!isTerminalKeyMessage(key)) {
      throw new TypeError('key must be a terminal key message');
    }
    owners.requireInput(event.sender);
    core.terminalKey(terminal, key);
  });
  registerHandler(IPC_CHANNELS.terminalMouse, (event, [id, pointer]) => {
    const terminal = use(event.sender, id);
    if (!isTerminalMouseMessage(pointer)) {
      throw new TypeError('event must be a terminal mouse message');
    }
    // Presses and releases reach programs that track the mouse; motion only reports places.
    if (pointer.action !== 'motion') {
      owners.requireInput(event.sender);
    }
    core.terminalMouse(terminal, {
      action: pointer.action,
      mods: pointer.mods,
      x: pointer.x,
      y: pointer.y,
      ...(pointer.button === undefined ? {} : { button: pointer.button }),
      ...(pointer.clicks === undefined ? {} : { clicks: pointer.clicks }),
    });
  });
  registerHandler(IPC_CHANNELS.terminalFocus, (event, [id, gained]) => {
    const terminal = use(event.sender, id);
    if (typeof gained !== 'boolean') {
      throw new TypeError('gained must be a boolean');
    }
    core.terminalFocus(terminal, gained);
  });
  registerHandler(IPC_CHANNELS.terminalPaste, async (event, [id, input, allowUnsafe]) => {
    const terminal = use(event.sender, id);
    const value = text(input, MAX_TERMINAL_PASTE, 'text');
    if (typeof allowUnsafe !== 'boolean') {
      throw new TypeError('allowUnsafe must be a boolean');
    }
    owners.requireInput(event.sender);
    return core.terminalPaste(terminal, value, allowUnsafe);
  });
}

function registerViewHandlers(
  registerHandler: TerminalRegistrar,
  core: TerminalCore,
  owners: TerminalOwners,
  stats: TerminalForwardStats,
  use: Use,
): void {
  registerHandler(IPC_CHANNELS.terminalResize, (event, [id, requested]) => {
    const terminal = use(event.sender, id);
    const { cols, rows, cellWidth, cellHeight } = size(requested);
    core.terminalResize(terminal, cols, rows, cellWidth, cellHeight);
  });
  registerHandler(IPC_CHANNELS.terminalRequestFrame, (event, [id, full, park]) => {
    const windowId = event.sender.id;
    const terminalId = use(event.sender, id);
    if (typeof full !== 'boolean' || (park !== undefined && typeof park !== 'boolean')) {
      throw new TypeError('full and park must be booleans');
    }
    if (!owners.beginPull(windowId, terminalId)) {
      throw new Error('A frame request for this terminal is in flight');
    }
    stats.requests += 1;
    // The frame is the reply (ADR-0023); a Core error rejects the window's request.
    return core.terminalFrame(terminalId, windowId, full, park === true).then(
      (frame) => {
        owners.endPull(windowId, terminalId);
        stats.frames += 1;
        stats.bytes += frame.byteLength;
        return frame;
      },
      (error: unknown) => {
        owners.endPull(windowId, terminalId);
        stats.errors += 1;
        throw error;
      },
    );
  });
  registerHandler(IPC_CHANNELS.terminalScroll, (event, [id, to]) => {
    const terminal = use(event.sender, id);
    if (!isTerminalScrollTarget(to)) {
      throw new TypeError('to must be a scroll target');
    }
    core.terminalScroll(terminal, JSON.stringify(to));
  });
  registerHandler(IPC_CHANNELS.terminalClearSelection, (event, [id]) => {
    core.terminalClearSelection(use(event.sender, id));
  });
  registerHandler(IPC_CHANNELS.terminalSelectionText, (event, [id]) =>
    core.terminalSelectionText(use(event.sender, id)),
  );
  registerHandler(IPC_CHANNELS.terminalLinkAt, (event, [id, col, row]) => {
    const terminal = use(event.sender, id);
    return parsed(core.terminalLinkAt(terminal, cell(col), cell(row)), terminalLinkOf);
  });
  registerHandler(IPC_CHANNELS.terminalSearch, (event, [id, query]) => {
    const terminal = use(event.sender, id);
    const needle = text(query, MAX_TERMINAL_QUERY, 'query');
    if (needle === '') {
      return Promise.resolve([]);
    }
    return parsed(core.terminalSearch(terminal, needle), terminalMatchesOf);
  });
  registerHandler(IPC_CHANNELS.terminalScreenText, (event, [id]) =>
    core.terminalText(use(event.sender, id), JSON.stringify({ kind: 'viewport' }), false),
  );
  registerHandler(IPC_CHANNELS.terminalInfo, (event, [id]) => {
    const terminal = use(event.sender, id);
    const info = terminalInfoOf(parseJson(core.terminalInfo(terminal)));
    if (info === undefined) {
      throw new Error('Core returned a malformed terminal answer');
    }
    return info;
  });
}
