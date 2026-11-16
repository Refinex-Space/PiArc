// The main-process side of `window.piarc` (src/shared/ipc.ts).
import { app, BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import { electronExternalLinkPort } from '../external-link-port.js';
import { LinkConfirmations } from '../external-links.js';
import type { RegisterHandler } from './register.js';

/** Registers every `window.piarc` command. */
export function registerIpcHandlers(registerHandler: RegisterHandler): void {
  const confirmations = new LinkConfirmations();
  registerHandler(IPC_CHANNELS.getAppVersion, () => app.getVersion());
  registerHandler(IPC_CHANNELS.openExternal, (event, [url]) =>
    confirmations.open(
      event.sender.id,
      url,
      electronExternalLinkPort(BrowserWindow.fromWebContents(event.sender)),
    ),
  );
}
