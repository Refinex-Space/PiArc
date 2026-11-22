import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { Translator } from '../../shared/i18n/index.js';
import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { IpcHandler } from '../ipc/register.js';
import {
  bundleId,
  defaultBundlePath,
  registerDiagnosticsHandlers,
  workspaceArg,
  type DiagnosticsCore,
  type SavePort,
} from './diagnostics-ipc.js';

function setup(chosen: string | null) {
  const handlers = new Map<string, IpcHandler>();
  const core = {
    prepareDiagnostics: vi.fn(() => Promise.resolve('{"id":"diag-1"}')),
    exportDiagnostics: vi.fn(() => Promise.resolve('{"path":"/x.zip","bytes":3}')),
  } satisfies DiagnosticsCore;
  const choosePath = vi.fn(() => Promise.resolve(chosen));
  const save: SavePort = { choosePath };
  registerDiagnosticsHandlers(
    (channel, handler) => handlers.set(channel, handler),
    core,
    () => new Translator('en'),
    save,
    () => ({ app: '0.1.0', electron: '45.3.2', platform: 'darwin' }),
  );
  const event = { sender: {} } as unknown as IpcMainInvokeEvent;
  const call = (channel: string, args: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return Promise.resolve(handler(event, args));
  };
  return { core, choosePath, call };
}

describe('diagnostic bundle IPC (T45)', () => {
  it('checks the workspace and the bundle id', () => {
    expect(workspaceArg(null)).toBeNull();
    expect(() => workspaceArg('relative/dir')).toThrow(TypeError);
    expect(() => workspaceArg(42)).toThrow(TypeError);
    expect(bundleId('diag-18ea4faa51702e68')).toBe('diag-18ea4faa51702e68');
    for (const bad of ['', 'diag-', 'diag-XYZ', '../diag-1', 7, null]) {
      expect(() => bundleId(bad)).toThrow(TypeError);
    }
  });

  it('names the default file after the local date and time', () => {
    const path = defaultBundlePath(new Date(2026, 10, 22, 9, 5), '/Users/me/Downloads');
    expect(path.endsWith('piarc-diagnostics-20261122-0905.zip')).toBe(true);
  });

  it('prepares with the client versions and writes nothing until the user picks a place', async () => {
    const cancelled = setup(null);
    await cancelled.call(IPC_CHANNELS.diagnosticsPrepare, [null]);
    const [, appJson] = cancelled.core.prepareDiagnostics.mock.calls[0] as unknown as [
      null,
      string,
    ];
    expect(JSON.parse(appJson)).toEqual({ app: '0.1.0', electron: '45.3.2', platform: 'darwin' });
    expect(await cancelled.call(IPC_CHANNELS.diagnosticsExport, ['diag-1'])).toBeNull();
    expect(cancelled.core.exportDiagnostics).not.toHaveBeenCalled();

    const chosen = setup('/Users/me/Downloads/bundle.zip');
    await chosen.call(IPC_CHANNELS.diagnosticsExport, ['diag-1']);
    expect(chosen.core.exportDiagnostics).toHaveBeenCalledWith(
      'diag-1',
      '/Users/me/Downloads/bundle.zip',
    );
    await expect(chosen.call(IPC_CHANNELS.diagnosticsExport, ['../x'])).rejects.toThrow(TypeError);
    expect(chosen.choosePath).toHaveBeenCalledTimes(1);
  });
});
