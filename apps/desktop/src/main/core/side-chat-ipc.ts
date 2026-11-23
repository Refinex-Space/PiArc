// A side conversation belongs to the page that opened it. Release its Host memory on
// navigation, window close or renderer crash, including while a model request is in flight.
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

import { IPC_CHANNELS, MAX_PROMPT_LENGTH, isSessionId } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

type SideCore = Pick<CoreRuntime, 'askSideChat' | 'controlSideChat'>;
interface Panel {
  readonly session: string;
  readonly clientId: string;
  readonly hostId: string;
}

export function registerSideChatHandlers(register: RegisterHandler, core: SideCore): void {
  const panels = new WeakMap<WebContents, Panel>();
  const watched = new WeakSet<WebContents>();
  function watch(sender: WebContents): void {
    if (watched.has(sender)) return;
    watched.add(sender);
    const release = () => {
      const panel = panels.get(sender);
      if (panel === undefined) return;
      panels.delete(sender);
      core.controlSideChat(panel.session, panel.hostId, true).catch((failure: unknown) => {
        console.error('[side chat] cannot release the closed page’s conversation', failure);
      });
    };
    sender.once('destroyed', release);
    sender.on('render-process-gone', release);
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) release();
    });
  }
  register(IPC_CHANNELS.sideChatAsk, ({ sender }, [session, clientId, question]) => {
    if (!isSessionId(session) || !isSessionId(clientId)) throw new TypeError('invalid side chat');
    if (typeof question !== 'string' || !question.trim() || question.length > MAX_PROMPT_LENGTH) {
      throw new TypeError('invalid side question');
    }
    watch(sender);
    let panel = panels.get(sender);
    if (panel === undefined) {
      panel = { session, clientId, hostId: randomUUID() };
      panels.set(sender, panel);
    } else if (panel.session !== session || panel.clientId !== clientId) {
      throw new Error('close the previous side chat first');
    }
    return core.askSideChat(session, panel.hostId, question);
  });
  register(IPC_CHANNELS.sideChatControl, ({ sender }, [session, clientId, close]) => {
    if (!isSessionId(session) || !isSessionId(clientId) || typeof close !== 'boolean') {
      throw new TypeError('invalid side chat control');
    }
    const panel = panels.get(sender);
    if (panel?.session !== session || panel.clientId !== clientId) return;
    if (close) panels.delete(sender);
    return core.controlSideChat(session, panel.hostId, close);
  });
}
