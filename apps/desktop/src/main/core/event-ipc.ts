// The window side of the event channel: one MessageChannelMain per page load. The preload
// script asks for it (`eventsConnect`), receives `port2` through `EVENTS_PORT_CHANNEL`, then
// subscribes route keys. The main process only ever posts on `port1`; messages the page
// might post back are never read.
import { MessageChannelMain, type WebContents } from 'electron';

import { EVENTS_PORT_CHANNEL, IPC_CHANNELS, isRouteKey } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { EventRouter } from './router.js';

/** Registers the three event commands of `window.piarc`. */
export function registerEventHandlers(registerHandler: RegisterHandler, router: EventRouter): void {
  const watched = new WeakSet<WebContents>();
  registerHandler(IPC_CHANNELS.eventsConnect, (event) => {
    connectWindow(router, event.sender, watched);
  });
  registerHandler(IPC_CHANNELS.eventsSubscribe, (event, [route]) => {
    if (!isRouteKey(route)) {
      throw new TypeError('route must be 1-128 characters of A-Z a-z 0-9 . _ : / -');
    }
    if (!router.subscribe(event.sender.id, route)) {
      throw new Error('This page has no event port; connect first');
    }
  });
  registerHandler(IPC_CHANNELS.eventsUnsubscribe, (event, [route]) => {
    if (!isRouteKey(route)) {
      throw new TypeError('route must be 1-128 characters of A-Z a-z 0-9 . _ : / -');
    }
    router.unsubscribe(event.sender.id, route);
  });
}

function connectWindow(router: EventRouter, contents: WebContents, watched: WeakSet<WebContents>) {
  const id = contents.id;
  const { port1, port2 } = new MessageChannelMain();
  router.connect(id, port1);
  // `close` fires when the page's end goes away (reload, navigation, crash).
  port1.on('close', () => {
    router.disconnect(id, port1);
  });
  port1.start();
  if (!watched.has(contents)) {
    watched.add(contents);
    contents.once('destroyed', () => {
      router.disconnect(id);
    });
  }
  contents.postMessage(EVENTS_PORT_CHANNEL, null, [port2]);
}
