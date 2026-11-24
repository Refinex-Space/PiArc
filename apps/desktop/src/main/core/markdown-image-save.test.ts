// Chromium does not deliver real renderer input while the native file chooser owns focus.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { Translator } from '../../shared/i18n/index.js';
import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { IpcHandler } from '../ipc/register.js';
import { registerMarkdownImageHandlers } from './markdown-images.js';
import { registerProjectFileHandlers } from './project-files-ipc.js';
import { INPUT_WINDOW_MS } from './terminal-ipc.js';

const chooser = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  dialog: { showOpenDialog: chooser },
  BrowserWindow: { getFocusedWindow: () => null, fromWebContents: () => null },
}));
it('a long native image choice authorizes exactly one autosave of the chosen insertion', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-picker-save-')),
    name = path.join(dir, 'photo.png');
  try {
    await writeFile(name, 'fixture');
    const frame = {},
      sender = Object.assign(new EventEmitter(), {
        id: 314,
        mainFrame: frame,
        isDestroyed: () => false,
      }) as unknown as WebContents;
    let now = 100,
      page = 7;
    const input = {
      requireInput: () => {
        if (now > 100 + INPUT_WINDOW_MS) throw new Error('needs recent input');
      },
      page: () => page,
    };
    const value = 'beforeOLD\r\nafter',
      revision = 'a'.repeat(64),
      expected = 'before![photo](./assets/photo.png)\r\nafter';
    const core = {
      markdownImageSettings: () => Promise.resolve('{}'),
      projectFiles: vi.fn((_session: string, raw: string) => {
        const r = JSON.parse(raw) as { op: string };
        return Promise.resolve(
          JSON.stringify(
            r.op === 'read'
              ? { kind: 'text', text: value, revision, editable: true }
              : r.op === 'imageImport'
                ? { alt: 'photo', href: './assets/photo.png' }
                : { revision, size: expected.length },
          ),
        );
      }),
    };
    const map = new Map<string, IpcHandler>(),
      register = (k: string, h: IpcHandler) => {
        map.set(k, h);
      };
    registerMarkdownImageHandlers(register, core, input, () => new Translator('en'));
    registerProjectFileHandlers(register, core, input, () => undefined);
    const call = async (
      channel: string,
      session: string,
      request: unknown,
      who: WebContents = sender,
    ) => {
      return await map.get(channel)?.(
        { sender: who, senderFrame: who.mainFrame } as IpcMainInvokeEvent,
        channel === IPC_CHANNELS.markdownImage ? [session, 'test.md', request] : [session, request],
      );
    };
    const save = { op: 'save', path: 'test.md', text: expected, revision };
    const pick = { op: 'pick', placement: { text: value, from: 6, to: 9, eol: '\r\n' } };
    const choose = async (cancel = false) => {
      now = 100;
      chooser.mockImplementationOnce(() => {
        now += INPUT_WINDOW_MS + 1200;
        return Promise.resolve({ canceled: cancel, filePaths: cancel ? [] : [name] });
      });
      await call(IPC_CHANNELS.markdownImage, 'session-one', pick);
    };
    await choose();
    await expect(
      call(IPC_CHANNELS.projectFiles, 'session-one', { ...save, path: 'other.md' }),
    ).rejects.toThrow('recent input');
    await expect(call(IPC_CHANNELS.projectFiles, 'session-two', save)).rejects.toThrow(
      'recent input',
    );
    await expect(
      call(IPC_CHANNELS.projectFiles, 'session-one', { ...save, text: 'unrelated replacement' }),
    ).rejects.toThrow('recent input');
    await expect(
      call(IPC_CHANNELS.projectFiles, 'session-one', { ...save, revision: 'b'.repeat(64) }),
    ).rejects.toThrow('recent input');
    const other = Object.assign(new EventEmitter(), {
      id: 315,
      mainFrame: {},
      isDestroyed: () => false,
    }) as unknown as WebContents;
    await expect(call(IPC_CHANNELS.projectFiles, 'session-one', save, other)).rejects.toThrow(
      'recent input',
    );
    await expect(call(IPC_CHANNELS.projectFiles, 'session-one', save)).resolves.toContain(revision);
    await expect(call(IPC_CHANNELS.projectFiles, 'session-one', save)).rejects.toThrow(
      'recent input',
    );
    // A picker cannot confer permission to change any other part of this document either.
    now = 100;
    chooser.mockImplementationOnce(() => {
      now += INPUT_WINDOW_MS + 1200;
      return Promise.resolve({ canceled: false, filePaths: [name] });
    });
    const unrelatedBase = {
      ...pick,
      placement: { ...pick.placement, text: 'unsafe replacement', from: 0, to: 0 },
    };
    await call(IPC_CHANNELS.markdownImage, 'session-one', unrelatedBase);
    await expect(
      call(IPC_CHANNELS.projectFiles, 'session-one', {
        ...save,
        text: '![photo](./assets/photo.png)unsafe replacement',
      }),
    ).rejects.toThrow('recent input');
    await choose(true);
    await expect(call(IPC_CHANNELS.projectFiles, 'session-one', save)).rejects.toThrow(
      'recent input',
    );
    await choose();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 30_000);
    try {
      await expect(call(IPC_CHANNELS.projectFiles, 'session-one', save)).rejects.toThrow(
        'recent input',
      );
    } finally {
      clock.mockRestore();
    }
    await choose();
    page++;
    await expect(call(IPC_CHANNELS.projectFiles, 'session-one', save)).rejects.toThrow(
      'recent input',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
