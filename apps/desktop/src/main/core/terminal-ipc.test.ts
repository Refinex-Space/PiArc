import { describe, expect, it } from 'vitest';

import { IPC_CHANNELS, type EventPortMessage } from '../../shared/ipc.js';
import { EventRouter, type EventPort } from './router.js';
import {
  registerTerminalHandlers,
  TerminalOwners,
  type OwnerContents,
  type TerminalCore,
} from './terminal-ipc.js';

class FakeContents implements OwnerContents {
  #destroyed: (() => void)[] = [];
  constructor(readonly id: number) {}
  once(_event: 'destroyed', listener: () => void): void {
    this.#destroyed.push(listener);
  }
  destroy(): void {
    for (const listener of this.#destroyed) {
      listener();
    }
  }
}

class RecordingPort implements EventPort {
  readonly messages: EventPortMessage[] = [];
  closed = false;
  postMessage(message: EventPortMessage): void {
    this.messages.push(message);
  }
  close(): void {
    this.closed = true;
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
  const router = new EventRouter();
  const owners = new TerminalOwners(core);
  const stats = { requests: 0, frames: 0, bytes: 0, errors: 0 };
  registerTerminalHandlers(
    (channel, handler) => handlers.set(channel, handler),
    core,
    router,
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
  return { calls, router, stats, invoke };
}

const size = { cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it('forwards each frame unread to the requesting window', async () => {
    const frame = new Uint8Array([0x50, 0x54, 0x46, 1]);
    const { calls, router, stats, invoke } = setup(() => Promise.resolve(frame));
    const window = new FakeContents(7);
    const port = new RecordingPort();
    router.connect(7, port);
    const id = invoke(window, IPC_CHANNELS.terminalCreate, size);
    invoke(window, IPC_CHANNELS.terminalRequestFrame, id, true);
    await flush();
    expect(calls).toContain('frame 1 viewer 7 full true');
    expect(port.messages).toEqual([{ terminalFrame: { terminalId: 1, frame } }]);
    expect(
      port.messages[0] !== undefined && 'terminalFrame' in port.messages[0]
        ? port.messages[0].terminalFrame.frame
        : undefined,
    ).toBe(frame);
    expect(stats).toEqual({ requests: 1, frames: 1, bytes: 4, errors: 0 });
  });

  it('reports a failed frame to the window', async () => {
    const { router, stats, invoke } = setup(() => Promise.reject(new Error('vt failed')));
    const window = new FakeContents(3);
    const port = new RecordingPort();
    router.connect(3, port);
    const id = invoke(window, IPC_CHANNELS.terminalCreate, size);
    invoke(window, IPC_CHANNELS.terminalRequestFrame, id, false);
    await flush();
    expect(port.messages).toEqual([{ terminalFrame: { terminalId: 1, error: 'vt failed' } }]);
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
});
