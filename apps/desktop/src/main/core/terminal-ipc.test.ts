import { describe, expect, it } from 'vitest';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import {
  registerTerminalHandlers,
  TerminalOwners,
  type NavigationDetails,
  type OwnerContents,
  type TerminalCore,
} from './terminal-ipc.js';

class FakeContents implements OwnerContents {
  #destroyed: (() => void)[] = [];
  #gone: (() => void)[] = [];
  #navigations: ((details: NavigationDetails) => void)[] = [];
  constructor(readonly id: number) {}
  once(_event: 'destroyed', listener: () => void): void {
    this.#destroyed.push(listener);
  }
  on(event: 'render-process-gone', listener: () => void): void;
  on(event: 'did-start-navigation', listener: (details: NavigationDetails) => void): void;
  on(
    event: 'render-process-gone' | 'did-start-navigation',
    listener: (details: NavigationDetails) => void,
  ): void {
    if (event === 'render-process-gone') {
      this.#gone.push(() => {
        listener({ isMainFrame: true, isSameDocument: false });
      });
    } else {
      this.#navigations.push(listener);
    }
  }
  destroy(): void {
    for (const listener of this.#destroyed) {
      listener();
    }
  }
  crash(): void {
    for (const listener of this.#gone) {
      listener();
    }
  }
  navigate(details: NavigationDetails): void {
    for (const listener of this.#navigations) {
      listener(details);
    }
  }
}

function setup(frame: () => Promise<Uint8Array>) {
  const calls: string[] = [];
  let next = 1;
  const core: TerminalCore = {
    createTerminal: (options) => {
      calls.push(`create ${String(options.cols)}x${String(options.rows)}`);
      return next++;
    },
    closeTerminal: (id) => calls.push(`close ${String(id)}`),
    terminalInput: (id, text) => calls.push(`input ${String(id)} ${text}`),
    terminalKey: (id, key) => calls.push(`key ${String(id)} ${key.code}`),
    terminalResize: (id, cols, rows) =>
      calls.push(`resize ${String(id)} ${String(cols)}x${String(rows)}`),
    terminalFrame: (id, viewer, full) => {
      calls.push(`frame ${String(id)} viewer ${String(viewer)} full ${String(full)}`);
      return frame();
    },
  };
  const handlers = new Map<
    string,
    (event: { readonly sender: OwnerContents }, args: readonly unknown[]) => unknown
  >();
  const owners = new TerminalOwners(core);
  const stats = { requests: 0, frames: 0, bytes: 0, errors: 0 };
  registerTerminalHandlers(
    (channel, handler) => handlers.set(channel, handler),
    core,
    owners,
    stats,
  );
  const invoke = (contents: OwnerContents, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) {
      throw new Error(`no handler for ${channel}`);
    }
    return handler({ sender: contents }, args);
  };
  return { calls, stats, invoke };
}

const size = { cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 };

describe('terminal IPC', () => {
  it('creates terminals for the calling window and checks sizes', () => {
    const { calls, invoke } = setup(() => Promise.resolve(new Uint8Array()));
    const window = new FakeContents(1);
    expect(invoke(window, IPC_CHANNELS.terminalCreate, size)).toBe(1);
    expect(calls).toEqual(['create 80x24']);
    for (const bad of [
      { ...size, cols: 0 },
      { ...size, rows: 1001 },
      { ...size, cellWidth: 1.5 },
      null,
    ]) {
      expect(() => invoke(window, IPC_CHANNELS.terminalCreate, bad)).toThrow(TypeError);
    }
  });

  it('lets only the owning window use a terminal', () => {
    const { calls, invoke } = setup(() => Promise.resolve(new Uint8Array()));
    const owner = new FakeContents(1);
    const other = new FakeContents(2);
    const id = invoke(owner, IPC_CHANNELS.terminalCreate, size);
    invoke(owner, IPC_CHANNELS.terminalInput, id, 'ls\r');
    expect(() => invoke(other, IPC_CHANNELS.terminalInput, id, 'rm -rf ~\r')).toThrow(
      'Unknown terminal',
    );
    expect(() => invoke(other, IPC_CHANNELS.terminalRequestFrame, id, false)).toThrow(
      'Unknown terminal',
    );
    expect(() => invoke(owner, IPC_CHANNELS.terminalInput, 99, 'x')).toThrow('Unknown terminal');
    expect(calls).toEqual(['create 80x24', 'input 1 ls\r']);
  });

  it('validates keys and input', () => {
    const { calls, invoke } = setup(() => Promise.resolve(new Uint8Array()));
    const window = new FakeContents(1);
    const id = invoke(window, IPC_CHANNELS.terminalCreate, size);
    const key = { action: 'press', code: 'KeyA', text: 'a', mods: 0, composing: false };
    invoke(window, IPC_CHANNELS.terminalKey, id, key);
    expect(() => invoke(window, IPC_CHANNELS.terminalKey, id, { ...key, action: 'tap' })).toThrow(
      TypeError,
    );
    expect(() => invoke(window, IPC_CHANNELS.terminalKey, id, { ...key, mods: 16 })).toThrow(
      TypeError,
    );
    expect(() => invoke(window, IPC_CHANNELS.terminalInput, id, 42)).toThrow(TypeError);
    expect(() => invoke(window, IPC_CHANNELS.terminalInput, id, 'x'.repeat(64 * 1024 + 1))).toThrow(
      TypeError,
    );
    invoke(window, IPC_CHANNELS.terminalResize, id, { ...size, cols: 100 });
    expect(calls).toEqual(['create 80x24', 'key 1 KeyA', 'resize 1 100x24']);
  });

  it('returns each frame unread as the reply to the request', async () => {
    const frame = new Uint8Array([0x50, 0x54, 0x46, 1]);
    const { calls, stats, invoke } = setup(() => Promise.resolve(frame));
    const window = new FakeContents(7);
    const id = invoke(window, IPC_CHANNELS.terminalCreate, size);
    const reply = invoke(window, IPC_CHANNELS.terminalRequestFrame, id, true);
    await expect(reply).resolves.toBe(frame);
    expect(calls).toContain('frame 1 viewer 7 full true');
    expect(stats).toEqual({ requests: 1, frames: 1, bytes: 4, errors: 0 });
    expect(() => invoke(window, IPC_CHANNELS.terminalRequestFrame, id, 'yes')).toThrow(TypeError);
  });

  it('rejects the request when Core cannot produce a frame', async () => {
    const { stats, invoke } = setup(() => Promise.reject(new Error('vt failed')));
    const window = new FakeContents(3);
    const id = invoke(window, IPC_CHANNELS.terminalCreate, size);
    await expect(invoke(window, IPC_CHANNELS.terminalRequestFrame, id, false)).rejects.toThrow(
      'vt failed',
    );
    expect(stats.errors).toBe(1);
  });

  it('closes the terminals of a window that goes away', () => {
    const { calls, invoke } = setup(() => Promise.resolve(new Uint8Array()));
    const window = new FakeContents(1);
    const other = new FakeContents(2);
    invoke(window, IPC_CHANNELS.terminalCreate, size);
    invoke(window, IPC_CHANNELS.terminalCreate, size);
    invoke(other, IPC_CHANNELS.terminalCreate, size);
    window.destroy();
    expect(calls.filter((c) => c.startsWith('close'))).toEqual(['close 1', 'close 2']);
    expect(() => invoke(window, IPC_CHANNELS.terminalInput, 1, 'x')).toThrow('Unknown terminal');
  });

  it("lets a window observe only its own terminals' events", () => {
    const owners = new TerminalOwners({
      createTerminal: () => 1,
      closeTerminal: () => undefined,
      terminalInput: () => undefined,
      terminalKey: () => undefined,
      terminalResize: () => undefined,
      terminalFrame: () => Promise.resolve(new Uint8Array()),
    });
    owners.assign(7, new FakeContents(1));
    expect(owners.mayObserve(1, 'term/7')).toBe(true);
    expect(owners.mayObserve(2, 'term/7')).toBe(false);
    expect(owners.mayObserve(1, 'term/8')).toBe(false);
    expect(owners.mayObserve(1, 'term/7x')).toBe(false);
    expect(owners.mayObserve(2, 'demo/1')).toBe(true);
  });

  it('closes the terminals of a page that reloads or crashes, not on in-page navigation', () => {
    const { calls, invoke } = setup(() => Promise.resolve(new Uint8Array()));
    const window = new FakeContents(1);
    const closes = () => calls.filter((c) => c.startsWith('close'));
    invoke(window, IPC_CHANNELS.terminalCreate, size);
    // A hash route change and a subframe navigation keep the page and its terminals.
    window.navigate({ isMainFrame: true, isSameDocument: true });
    window.navigate({ isMainFrame: false, isSameDocument: false });
    expect(closes()).toEqual([]);
    // A reload starts a new document: the new page cannot know the old ids.
    window.navigate({ isMainFrame: true, isSameDocument: false });
    expect(closes()).toEqual(['close 1']);
    expect(() => invoke(window, IPC_CHANNELS.terminalInput, 1, 'x')).toThrow('Unknown terminal');
    invoke(window, IPC_CHANNELS.terminalCreate, size);
    window.crash();
    expect(closes()).toEqual(['close 1', 'close 2']);
  });
});
