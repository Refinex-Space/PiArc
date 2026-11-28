import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { Translator } from '../../shared/i18n/index.js';
import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { IpcHandler } from '../ipc/register.js';
import {
  bulkOp,
  exportFileName,
  exportLabels,
  registerDataHandlers,
  sessionIds,
  type DataCore,
  type DataDialogs,
} from './data-ipc.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup({
  answer = 0,
  chosen = '/Users/me/Downloads/x.zip',
}: { answer?: number; chosen?: string | null } = {}) {
  const handlers = new Map<string, IpcHandler>();
  const core = {
    setSessionArchived: vi.fn(() => Promise.resolve('null')),
    deleteSession: vi.fn((id: string) =>
      id === ID(3) ? Promise.reject(new Error('busy')) : Promise.resolve('null'),
    ),
    sessionDeletionTarget: vi.fn((id: string) =>
      Promise.resolve(JSON.stringify({ title: `Title ${id.slice(-1)}`, workspace: '/w' })),
    ),
    exportSessions: vi.fn(() => Promise.resolve('{"path":"/x.zip","bytes":10,"sessions":2}')),
  } satisfies DataCore;
  const asked: Electron.MessageBoxOptions[] = [];
  const reveal = vi.fn();
  const dialogs: DataDialogs = {
    ask: vi.fn((_sender, options: Electron.MessageBoxOptions) => {
      asked.push(options);
      return Promise.resolve(answer);
    }),
    savePath: vi.fn(() => Promise.resolve(chosen)),
    reveal,
  };
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  registerDataHandlers(
    (channel, handler) => handlers.set(channel, handler),
    core,
    () => new Translator('en'),
    dialogs,
  );
  const event = { sender: {} } as unknown as IpcMainInvokeEvent;
  const call = (channel: string, args: unknown[] = []) => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(handler(event, args));
  };
  return { core, reveal, asked, call };
}

describe('data management IPC', () => {
  it('checks the operation and the session ids', () => {
    expect(bulkOp('delete')).toBe('delete');
    expect(() => bulkOp('purge')).toThrow(TypeError);
    expect(sessionIds([ID(1), ID(1), ID(2)])).toEqual([ID(1), ID(2)]);
    for (const bad of [[], 'x', [ID(1), '../etc'], Array.from({ length: 10_001 }, () => ID(1))]) {
      expect(() => sessionIds(bad)).toThrow(TypeError);
    }
  });

  it('deletes only after the native confirmation, listing the titles from Core', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => ID(i + 1));
    const cancelled = setup({ answer: 1 });
    expect(await cancelled.call(IPC_CHANNELS.sessionsBulk, ['delete', ids])).toBeNull();
    expect(cancelled.core.deleteSession).not.toHaveBeenCalled();
    const [dialog] = cancelled.asked;
    expect(dialog?.message).toBe('Permanently delete 10 sessions?');
    expect(dialog?.detail).toContain('• Title 1');
    expect(dialog?.detail).toContain('…and 2 more');
    expect(dialog?.detail).not.toContain('Title 9');
    expect(dialog?.cancelId).toBe(1);

    const confirmed = setup({ answer: 0 });
    // One session fails (Core refuses it): the rest go, the result counts both.
    expect(await confirmed.call(IPC_CHANNELS.sessionsBulk, ['delete', ids])).toEqual({
      done: 9,
      failed: 1,
    });
    expect(confirmed.core.deleteSession).toHaveBeenCalledTimes(10);
  });

  it('archives after a confirmation and restores without one', async () => {
    const archived = setup({ answer: 0 });
    expect(await archived.call(IPC_CHANNELS.sessionsBulk, ['archive', [ID(1), ID(2)]])).toEqual({
      done: 2,
      failed: 0,
    });
    expect(archived.asked[0]?.message).toBe('Archive 2 sessions?');
    expect(archived.core.setSessionArchived).toHaveBeenCalledWith(ID(1), true);

    const restored = setup();
    await restored.call(IPC_CHANNELS.sessionsBulk, ['unarchive', [ID(1)]]);
    expect(restored.asked).toHaveLength(0);
    expect(restored.core.setSessionArchived).toHaveBeenCalledWith(ID(1), false);
  });

  it('exports only where the user picked, in the interface words, and reveals only that file', async () => {
    const cancelled = setup({ chosen: null });
    expect(await cancelled.call(IPC_CHANNELS.dataExport)).toBeNull();
    expect(cancelled.core.exportSessions).not.toHaveBeenCalled();
    expect(await cancelled.call(IPC_CHANNELS.dataExportReveal)).toBe(false);
    expect(cancelled.reveal).not.toHaveBeenCalled();

    const chosen = setup();
    expect(await chosen.call(IPC_CHANNELS.dataExport)).toBe(
      '{"path":"/x.zip","bytes":10,"sessions":2}',
    );
    const [target, labels] = chosen.core.exportSessions.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(target).toBe('/Users/me/Downloads/x.zip');
    const words = JSON.parse(labels) as { user: string; untitled: string };
    expect(words.user).toBe('You');
    expect(words.untitled.length).toBeGreaterThan(0);
    expect(await chosen.call(IPC_CHANNELS.dataExportReveal)).toBe(true);
    expect(chosen.reveal).toHaveBeenCalledWith('/Users/me/Downloads/x.zip');
  });

  it('names the file after the local time and passes the clock offset', () => {
    expect(exportFileName(new Date(2026, 10, 28, 9, 5))).toBe('piarc-export-20261128-0905.zip');
    const labels = JSON.parse(exportLabels(new Translator('zh-CN'), new Date())) as {
      user: string;
      offsetMinutes: number;
    };
    expect(labels.user).toBe('你');
    expect(labels.offsetMinutes).toBe(0 - new Date().getTimezoneOffset());
  });
});
