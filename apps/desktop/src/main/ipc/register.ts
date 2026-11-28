// The only place that calls `ipcMain.handle` (enforced by ESLint). Every handler is wrapped
// so that a request from an untrusted frame is rejected and logged before the handler runs, and
// so that a Core error keeps its kind on the way to the page (`page-errors.ts`).
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { answer } from './page-errors.js';
import { isTrustedSender } from './sender.js';

/** A command handler. `args` come from the renderer and must be validated by the handler. */
export type IpcHandler = (event: IpcMainInvokeEvent, args: readonly unknown[]) => unknown;

/** Registers IPC handlers that only answer frames of `trustedOrigins`. */
export function createIpcRegistrar(trustedOrigins: readonly string[]) {
  return function registerHandler(channel: string, handler: IpcHandler): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      const frame = event.senderFrame;
      if (!isTrustedSender(frame, trustedOrigins)) {
        console.warn(`[ipc] rejected ${channel} from ${frame?.origin ?? '<no frame>'}`);
        throw new Error(`IPC request ${channel} rejected: untrusted sender`);
      }
      return answer(() => handler(event, args));
    });
  };
}

/** The function returned by `createIpcRegistrar`. */
export type RegisterHandler = ReturnType<typeof createIpcRegistrar>;

/**
 * Registers the handler of the agent's script host (ADR-0089 rule 3). The host is not a
 * workbench page: its channel answers only a webContents `isHost` accepts (the host of the
 * run in progress), and workbench pages cannot reach it. Errors reach the host as they are.
 */
export function registerHostHandler(
  channel: string,
  isHost: (sender: Electron.WebContents) => boolean,
  handler: (sender: Electron.WebContents, request: unknown) => unknown,
): void {
  ipcMain.handle(channel, (event, request: unknown) => {
    if (!isHost(event.sender)) {
      console.warn(`[ipc] rejected ${channel} from a page that is not a script host`);
      throw new Error(`IPC request ${channel} rejected: not a script host`);
    }
    return handler(event.sender, request);
  });
}
