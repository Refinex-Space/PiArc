// Native menu commands belong to the last focused workbench; an IPC request belongs to its sender.
import { EventEmitter } from 'node:events';

import type { IpcMainInvokeEvent } from 'electron';
import { expect, it, vi } from 'vitest';

import { APP_EVENT_CHANNEL, IPC_CHANNELS } from '../shared/ipc.js';
import { AppShell } from './app-shell.js';
import type { IpcHandler } from './ipc/register.js';
import { WindowStateFile } from './platform/window-state.js';
import { PreferenceStore } from './preferences.js';

const { create, owner } = vi.hoisted(() => ({ create: vi.fn(), owner: vi.fn() }));
vi.mock('./window.js', () => ({
  createMainWindow: create,
  MAIN_WINDOW_MIN: { width: 960, height: 600 },
}));
vi.mock('./platform/window-chrome.js', () => ({ followTheme: vi.fn(), mainWindowChrome: vi.fn() }));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: owner },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
    getAllDisplays: () => [],
  },
}));

function makeWindow(id: number) {
  return Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { id, send: vi.fn() }),
    isMinimized: () => false,
    isDestroyed: () => false,
    focus: vi.fn(),
    show: vi.fn(),
    loadURL: vi.fn(),
  });
}

it('queues a cold menu open and directs later opens to the owning workbench without creating a settings window', () => {
  const first = makeWindow(11),
    second = makeWindow(12);
  create.mockReturnValueOnce(first).mockReturnValueOnce(second);
  owner.mockImplementation(
    (contents: unknown) => [first, second].find((w) => w.webContents === contents) ?? null,
  );
  const state = new WindowStateFile('unused');
  vi.spyOn(state, 'load').mockReturnValue(undefined);
  const shell = new AppShell({
    preloadPath: 'preload.cjs',
    entryUrl: 'app://piarc/index.html',
    developer: false,
    windowState: state,
    quit: vi.fn(),
    preferences: new PreferenceStore({ userSettings: vi.fn(), writeClientSetting: vi.fn() }, () => [
      'en',
    ]),
  });
  const handlers = new Map<string, IpcHandler>();
  shell.registerHandlers((channel, handler) => {
    handlers.set(channel, handler);
  });
  const invoke = (channel: string, window: typeof first, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('Missing IPC handler');
    return handler({ sender: window.webContents } as unknown as IpcMainInvokeEvent, args);
  };

  shell.run('app.settings');
  expect(shell.mainWindows()).toEqual([first]);
  expect(invoke(IPC_CHANNELS.launchTargets, first)).toEqual([{ kind: 'settings' }]);
  expect(invoke(IPC_CHANNELS.launchTargets, first)).toEqual([]);
  shell.openMain();
  invoke(IPC_CHANNELS.launchTargets, second);
  expect(shell.mainWindow()).toBe(second);

  invoke(IPC_CHANNELS.settingsOpen, first, 'memory');
  invoke(IPC_CHANNELS.settingsOpen, first, 'memory');
  expect(first.webContents.send.mock.calls).toEqual(
    Array.from({ length: 2 }, () => [
      APP_EVENT_CHANNEL,
      { type: 'launch', target: { kind: 'settings', page: 'memory' } },
    ]),
  );
  expect(second.webContents.send).not.toHaveBeenCalled();
  expect(() => invoke(IPC_CHANNELS.settingsOpen, first, '../other')).toThrow('settings page id');

  shell.run('app.settings');
  expect(second.webContents.send).toHaveBeenCalledWith(APP_EVENT_CHANNEL, {
    type: 'launch',
    target: { kind: 'settings' },
  });
  expect(shell.mainWindows()).toHaveLength(2);
  first.emit('focus');
  first.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  shell.run('app.settings');
  expect(invoke(IPC_CHANNELS.launchTargets, first)).toEqual([{ kind: 'settings' }]);
  expect(shell.mainWindow()).toBe(first);
});
