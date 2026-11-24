// A side conversation belongs to the page that opened it. Release its Host memory on
// navigation, window close or renderer crash, including while a model request is in flight.
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

import { IPC_CHANNELS, MAX_PROMPT_LENGTH, MAX_SIDE_CHATS, isSessionId } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

type SideCore = Pick<CoreRuntime, 'askSideChat' | 'controlSideChat'>;
interface Panel {
  readonly session: string;
  readonly hostId: string;
}

export function registerSideChatHandlers(register: RegisterHandler, core: SideCore): void {
  const panels = new WeakMap<WebContents, Map<string, Panel>>();
  const watched = new WeakSet<WebContents>();
  function watch(sender: WebContents): void {
    if (watched.has(sender)) return;
    watched.add(sender);
    const release = () => {
      const owned = panels.get(sender);
      if (owned === undefined) return;
      panels.delete(sender);
      for (const panel of owned.values())
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
    const owned = panels.get(sender) ?? new Map<string, Panel>();
    let panel = owned.get(clientId);
    if (panel === undefined) {
      if (owned.size >= MAX_SIDE_CHATS) throw new Error('Too many side chats');
      panel = { session, hostId: randomUUID() };
      owned.set(clientId, panel);
      panels.set(sender, owned);
    } else if (panel.session !== session) {
      throw new Error('Side chat belongs to another session');
    }
    return core.askSideChat(session, panel.hostId, question);
  });
  register(IPC_CHANNELS.sideChatControl, ({ sender }, [session, clientId, close]) => {
    if (!isSessionId(session) || !isSessionId(clientId) || typeof close !== 'boolean') {
      throw new TypeError('invalid side chat control');
    }
    const owned = panels.get(sender);
    const panel = owned?.get(clientId);
    if (panel?.session !== session) return;
    if (close) owned?.delete(clientId);
    return core.controlSideChat(session, panel.hostId, close);
  });
}
