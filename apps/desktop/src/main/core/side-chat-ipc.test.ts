import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { IpcHandler } from '../ipc/register.js';
import { registerSideChatHandlers } from './side-chat-ipc.js';

it('owns each side tab separately and releases the remaining conversations when its page is destroyed', async () => {
  const core = {
    askSideChat: vi.fn().mockResolvedValue('{}'),
    controlSideChat: vi.fn().mockResolvedValue(undefined),
  };
  const handlers = new Map<string, IpcHandler>();
  registerSideChatHandlers((channel, handler) => {
    handlers.set(channel, handler);
  }, core);
  const page = new EventEmitter();
  const event = { sender: page as unknown as WebContents } as IpcMainInvokeEvent;
  const ask = (tab: string, session = 'parent') =>
    handlers.get(IPC_CHANNELS.sideChatAsk)?.(event, [session, tab, 'Question']);
  await ask('first');
  await ask('second');
  await ask('first');
  const hostIds = core.askSideChat.mock.calls.map((args) => args[1] as string);
  expect(hostIds[0]).toBe(hostIds[2]);
  expect(hostIds[1]).not.toBe(hostIds[0]);
  expect(() => ask('first', 'unrelated')).toThrow('another session');
  await handlers.get(IPC_CHANNELS.sideChatControl)?.(event, ['parent', 'first', true]);
  expect(core.controlSideChat.mock.calls).toEqual([['parent', hostIds[0], true]]);
  page.emit('destroyed');
  expect(core.controlSideChat.mock.calls).toEqual([
    ['parent', hostIds[0], true],
    ['parent', hostIds[1], true],
  ]);
});
