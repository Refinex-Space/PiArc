import { EventEmitter } from 'node:events';
import type { HandlerDetails, IpcMainInvokeEvent, WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../shared/ipc.js';
import type { IpcHandler } from './ipc/register.js';
import { ToolWindows } from './tool-windows.js';

it('THR-13 restricts each native tool ticket to one page, document and use', async () => {
  const owner = Object.assign(new EventEmitter(), {
    mainFrame: {},
    getURL: () => 'app://piarc/index.html',
    isDestroyed: () => false,
  }) as unknown as WebContents;
  const other = {} as WebContents;
  let revision = 1;
  const input = { requireInput: vi.fn(), page: () => revision, bindToolInput: vi.fn() };
  const manager = new ToolWindows(
    input,
    (sender) => sender === owner,
    (session) => Promise.resolve(session === 'session-one'),
  );
  const handlers = new Map<string, IpcHandler>();
  manager.register((channel, handler) => {
    handlers.set(channel, handler);
  });
  const prepare = (session = 'session-one', id = 'terminal', frame = owner.mainFrame) =>
    handlers.get(IPC_CHANNELS.toolWindowPrepare)?.(
      { sender: owner, senderFrame: frame } as IpcMainInvokeEvent,
      [session, id],
    ) as Promise<string>;
  await expect(prepare('absent')).rejects.toThrow();
  await expect(prepare('session-one', 'unknown')).rejects.toThrow();
  await expect(prepare('session-one', 'changes', {} as typeof owner.mainFrame)).rejects.toThrow();
  const ticket = await prepare();
  expect(input.requireInput).toHaveBeenCalledWith(owner);
  const request = {
    frameName: ticket,
    url: 'app://piarc/tool-window.html',
    features: '',
  } as HandlerDetails;
  expect(manager.open(other, request)).toBeUndefined();
  expect(manager.open(owner, { ...request, frameName: 'unused' })).toBeUndefined();
  expect(manager.open(owner, { ...request, url: 'app://piarc/index.html' })).toBeUndefined();
  expect(manager.open(owner, { ...request, features: 'width=600' })).toBeUndefined();
  expect(manager.open(owner, request)).toMatchObject({
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: {
        preload: '',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  });
  expect(manager.open(owner, request)).toBeUndefined();
  const stale = await prepare();
  revision++;
  expect(manager.open(owner, { ...request, frameName: stale })).toBeUndefined();
  const expired = await prepare();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
  try {
    expect(manager.open(owner, { ...request, frameName: expired })).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});
