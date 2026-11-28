// The main-process side of `window.piarc` (src/shared/ipc.ts).
import { app, BrowserWindow } from 'electron';

import type { Translator } from '../../shared/i18n/index.js';
import { IPC_CHANNELS } from '../../shared/ipc.js';
import { electronExternalLinkPort } from '../external-link-port.js';
import { LinkConfirmations } from '../external-links.js';
import type { RegisterHandler } from './register.js';

/** Registers every `window.piarc` command; `translator` is the current language's. */
export function registerIpcHandlers(
  registerHandler: RegisterHandler,
  translator: () => Translator,
): void {
  const confirmations = new LinkConfirmations();
  registerHandler(IPC_CHANNELS.getAppVersion, () => app.getVersion());
  // A string the main process will not open answers false; anything else is a caller's error.
  registerHandler(IPC_CHANNELS.openExternal, (event, [url]) => {
    if (typeof url !== 'string') throw new TypeError('url must be a string');
    return confirmations.open(
      event.sender.id,
      url,
      electronExternalLinkPort(BrowserWindow.fromWebContents(event.sender), translator()),
    );
  });
}
