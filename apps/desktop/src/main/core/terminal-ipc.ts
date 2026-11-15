// The terminal commands of `window.piarc` (ADR-0017, T10). The main process only checks
// arguments and ownership and forwards: Core encodes keys and produces frames, and each
// frame goes back unread on the requesting window's event port (the T04 channel, copied by
// structured clone per ADR-0019).
import {
  IPC_CHANNELS,
  isTerminalKeyMessage,
  isTerminalSize,
  type TerminalSize,
} from '../../shared/ipc.js';
import type { TerminalForwardStats } from '../../shared/test-hooks.js';
import type { CoreRuntime } from './native/piarc-core.js';
import type { EventRouter } from './router.js';

/** Longest text one `terminalInput` call may write (characters). */
export const MAX_TERMINAL_INPUT = 64 * 1024;

/** The Core calls this module makes; the real runtime satisfies it. */
export type TerminalCore = Pick<
  CoreRuntime,
  | 'createTerminal'
  | 'closeTerminal'
  | 'terminalInput'
  | 'terminalKey'
  | 'terminalResize'
  | 'terminalFrame'
>;

/** The part of a window's `WebContents` ownership needs. */
export interface OwnerContents {
  readonly id: number;
  once(event: 'destroyed', listener: () => void): unknown;
}

/** `registerHandler` (src/main/ipc/register.ts) as this module uses it. */
export type TerminalRegistrar = (
  channel: string,
  handler: (event: { readonly sender: OwnerContents }, args: readonly unknown[]) => unknown,
) => void;

/**
 * Which window owns which terminal. A window may only use its own terminals; closing or
 * crashing the window closes them.
 */
export class TerminalOwners {
  readonly #owners = new Map<number, number>();
  readonly #watched = new WeakSet<OwnerContents>();
  readonly #core: TerminalCore;

  constructor(core: TerminalCore) {
    this.#core = core;
  }

  /** Records that `contents` owns terminal `id` and closes it when `contents` goes away. */
  assign(id: number, contents: OwnerContents): void {
    this.#owners.set(id, contents.id);
    if (!this.#watched.has(contents)) {
      this.#watched.add(contents);
      const windowId = contents.id;
      contents.once('destroyed', () => {
        this.closeAllOf(windowId);
      });
    }
  }

  /** `id` as a terminal id that window `windowId` owns; throws otherwise. */
  check(windowId: number, id: unknown): number {
    if (typeof id !== 'number' || !Number.isInteger(id) || this.#owners.get(id) !== windowId) {
      throw new TypeError('Unknown terminal');
    }
    return id;
  }

  release(id: number): void {
    this.#owners.delete(id);
  }

  closeAllOf(windowId: number): void {
    for (const [id, owner] of [...this.#owners]) {
      if (owner !== windowId) {
        continue;
      }
      this.#owners.delete(id);
      try {
        this.#core.closeTerminal(id);
      } catch (error) {
        // The program may have exited and Core shut down already.
        console.warn(`[core] closing terminal ${String(id)} failed`, error);
      }
    }
  }
}

function size(value: unknown): TerminalSize {
  if (!isTerminalSize(value)) {
    throw new TypeError('size must be { cols, rows, cellWidth, cellHeight } within limits');
  }
  return value;
}

/** Registers the six terminal commands. `stats` counts forwarded frames for the test hooks. */
export function registerTerminalHandlers(
  registerHandler: TerminalRegistrar,
  core: TerminalCore,
  router: EventRouter,
  owners: TerminalOwners,
  stats: TerminalForwardStats,
): void {
  registerHandler(IPC_CHANNELS.terminalCreate, (event, [requested]) => {
    const { cols, rows, cellWidth, cellHeight } = size(requested);
    const id = core.createTerminal({ cols, rows, cellWidth, cellHeight });
    owners.assign(id, event.sender);
    return id;
  });
  registerHandler(IPC_CHANNELS.terminalClose, (event, [id]) => {
    const terminal = owners.check(event.sender.id, id);
    owners.release(terminal);
    core.closeTerminal(terminal);
  });
  registerHandler(IPC_CHANNELS.terminalInput, (event, [id, text]) => {
    const terminal = owners.check(event.sender.id, id);
    if (typeof text !== 'string' || text.length > MAX_TERMINAL_INPUT) {
      throw new TypeError(`text must be a string of at most ${String(MAX_TERMINAL_INPUT)}`);
    }
    core.terminalInput(terminal, text);
  });
  registerHandler(IPC_CHANNELS.terminalKey, (event, [id, key]) => {
    const terminal = owners.check(event.sender.id, id);
    if (!isTerminalKeyMessage(key)) {
      throw new TypeError('key must be a terminal key message');
    }
    core.terminalKey(terminal, key);
  });
  registerHandler(IPC_CHANNELS.terminalResize, (event, [id, requested]) => {
    const terminal = owners.check(event.sender.id, id);
    const { cols, rows, cellWidth, cellHeight } = size(requested);
    core.terminalResize(terminal, cols, rows, cellWidth, cellHeight);
  });
  registerHandler(IPC_CHANNELS.terminalRequestFrame, (event, [id, full]) => {
    const windowId = event.sender.id;
    const terminalId = owners.check(windowId, id);
    if (typeof full !== 'boolean') {
      throw new TypeError('full must be a boolean');
    }
    stats.requests += 1;
    core.terminalFrame(terminalId, windowId, full).then(
      (frame) => {
        stats.frames += 1;
        stats.bytes += frame.byteLength;
        router.postToWindow(windowId, { terminalFrame: { terminalId, frame } });
      },
      (error: unknown) => {
        stats.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        router.postToWindow(windowId, { terminalFrame: { terminalId, error: message } });
      },
    );
  });
}
