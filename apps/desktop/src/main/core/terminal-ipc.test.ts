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

/** `started` holds back every terminal start until it resolves. */
function setup(frame: () => Promise<Uint8Array>, started: Promise<void> = Promise.resolve()) {
  const calls: string[] = [];
  let next = 1;
  const core: TerminalCore = {
    createTerminal: async (options) => {
      calls.push(`create ${String(options.cols)}x${String(options.rows)}`);
      const id = next++;
      await started;
      return id;
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
  const create = async (contents: OwnerContents): Promise<number> => {
    const id: unknown = await invoke(contents, IPC_CHANNELS.terminalCreate, size);
    if (typeof id !== 'number') {
      throw new TypeError('terminal ids are numbers');
    }
    return id;
  };
  return { calls, stats, invoke, create };
}

const size = { cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 };

describe('terminal IPC', () => {
  it('creates terminals for the calling window and checks sizes', async () => {
    const { calls, invoke, create } = setup(() => Promise.resolve(new Uint8Array()));
    const window = new FakeContents(1);
    await expect(create(window)).resolves.toBe(1);
    expect(calls).toEqual(['create 80x24']);
    for (const bad of [
      { ...size, cols: 0 },
      { ...size, rows: 1001 },
      { ...size, cellWidth: 1.5 },
      null,
    ]) {
      await expect(invoke(window, IPC_CHANNELS.terminalCreate, bad)).rejects.toThrow(TypeError);
    }
    expect(calls).toEqual(['create 80x24']);
  });

  it('closes a terminal whose page went away while it started', async () => {
    let start: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const { calls, invoke } = setup(() => Promise.resolve(new Uint8Array()), started);
    const window = new FakeContents(1);
    const pending = invoke(window, IPC_CHANNELS.terminalCreate, size);
    window.navigate({ isMainFrame: true, isSameDocument: false });
    start();
    await expect(pending).rejects.toThrow('went away');
    expect(calls).toEqual(['create 80x24', 'close 1']);
    expect(() => invoke(window, IPC_CHANNELS.terminalInput, 1, 'x')).toThrow('Unknown terminal');
  });

  it('lets only the owning window use a terminal', async () => {
    const { calls, invoke, create } = setup(() => Promise.resolve(new Uint8Array()));
    const owner = new FakeContents(1);
    const other = new FakeContents(2);
    const id = await create(owner);
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

  it('validates keys and input', async () => {
    const { calls, invoke, create } = setup(() => Promise.resolve(new Uint8Array()));
    const window = new FakeContents(1);
    const id = await create(window);
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
    const { calls, stats, invoke, create } = setup(() => Promise.resolve(frame));
    const window = new FakeContents(7);
    const id = await create(window);
    const reply = invoke(window, IPC_CHANNELS.terminalRequestFrame, id, true);
    await expect(reply).resolves.toBe(frame);
    expect(calls).toContain('frame 1 viewer 7 full true');
    expect(stats).toEqual({ requests: 1, frames: 1, bytes: 4, errors: 0 });
    expect(() => invoke(window, IPC_CHANNELS.terminalRequestFrame, id, 'yes')).toThrow(TypeError);
  });

  it('rejects the request when Core cannot produce a frame', async () => {
    const { stats, invoke, create } = setup(() => Promise.reject(new Error('vt failed')));
    const window = new FakeContents(3);
    const id = await create(window);
    await expect(invoke(window, IPC_CHANNELS.terminalRequestFrame, id, false)).rejects.toThrow(
      'vt failed',
    );
    expect(stats.errors).toBe(1);
  });

  it('closes the terminals of a window that goes away', async () => {
    const { calls, invoke, create } = setup(() => Promise.resolve(new Uint8Array()));
    const window = new FakeContents(1);
    const other = new FakeContents(2);
    await create(window);
    await create(window);
    await create(other);
    window.destroy();
    expect(calls.filter((c) => c.startsWith('close'))).toEqual(['close 1', 'close 2']);
    expect(() => invoke(window, IPC_CHANNELS.terminalInput, 1, 'x')).toThrow('Unknown terminal');
  });

  it("lets a window observe only its own terminals' events", () => {
    const owners = new TerminalOwners({
      createTerminal: () => Promise.resolve(1),
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

  it('closes the terminals of a page that reloads or crashes, not on in-page navigation', async () => {
    const { calls, invoke, create } = setup(() => Promise.resolve(new Uint8Array()));
    const window = new FakeContents(1);
    const closes = () => calls.filter((c) => c.startsWith('close'));
    await create(window);
    // A hash route change and a subframe navigation keep the page and its terminals.
    window.navigate({ isMainFrame: true, isSameDocument: true });
    window.navigate({ isMainFrame: false, isSameDocument: false });
    expect(closes()).toEqual([]);
    // A reload starts a new document: the new page cannot know the old ids.
    window.navigate({ isMainFrame: true, isSameDocument: false });
    expect(closes()).toEqual(['close 1']);
    expect(() => invoke(window, IPC_CHANNELS.terminalInput, 1, 'x')).toThrow('Unknown terminal');
    await create(window);
    window.crash();
    expect(closes()).toEqual(['close 1', 'close 2']);
  });
});
