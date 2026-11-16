import { describe, expect, it } from 'vitest';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import { registerEventHandlers } from './event-ipc.js';
import type { EventRouter } from './router.js';

type Handler = Parameters<RegisterHandler>[1];

function setup(authorize: (windowId: number, route: string) => boolean) {
  const handlers = new Map<string, Handler>();
  const subscribed: string[] = [];
  const router = {
    subscribe: (windowId: number, route: string) => {
      subscribed.push(`${String(windowId)} ${route}`);
      return true;
    },
    unsubscribe: () => undefined,
  } as unknown as EventRouter;
  registerEventHandlers((channel, handler) => handlers.set(channel, handler), router, authorize);
  const subscribe = (windowId: number, route: string) => {
    const handler = handlers.get(IPC_CHANNELS.eventsSubscribe);
    if (handler === undefined) {
      throw new Error('no subscribe handler');
    }
    return handler({ sender: { id: windowId } } as Parameters<Handler>[0], [route]);
  };
  return { subscribed, subscribe };
}

describe('event subscriptions', () => {
  it('refuses routes the window may not observe', () => {
    const { subscribed, subscribe } = setup(
      (windowId, route) => route !== 'term/1' || windowId === 1,
    );
    subscribe(1, 'term/1');
    expect(() => subscribe(2, 'term/1')).toThrow('not allowed');
    subscribe(2, 'demo');
    expect(subscribed).toEqual(['1 term/1', '2 demo']);
  });
});
