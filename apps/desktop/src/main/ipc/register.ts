// The only place that calls `ipcMain.handle` (enforced by ESLint). Every handler is wrapped
// so that a request from an untrusted frame is rejected and logged before the handler runs.
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

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
      return handler(event, args);
    });
  };
}

/** The function returned by `createIpcRegistrar`. */
export type RegisterHandler = ReturnType<typeof createIpcRegistrar>;
