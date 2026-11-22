// The diagnostic bundle (T45, architecture section 10.5): the diagnostics page asks Core to
// prepare the bundle and shows its file list and redaction summary; exporting writes that same
// bundle only after the user picked a place in the main process's native save dialog, so the
// page can neither write without the user nor choose where.
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, dialog, type WebContents } from 'electron';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type DiagnosticsCore = Pick<CoreRuntime, 'prepareDiagnostics' | 'exportDiagnostics'>;

/** Where the save dialog asks the user for a path; replaced in tests. */
export interface SavePort {
  /** The path the user chose for the window of `sender`, or null when cancelled. */
  choosePath(sender: WebContents, title: string): Promise<string | null>;
}

/** The Electron save dialog, starting in the Downloads folder. */
export const electronSavePort: SavePort = {
  async choosePath(sender, title) {
    const window = BrowserWindow.fromWebContents(sender);
    const options = {
      title,
      defaultPath: defaultBundlePath(new Date(), app.getPath('downloads')),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);
    return result.canceled || result.filePath === '' ? null : result.filePath;
  },
};

export function workspaceArg(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096) {
    throw new TypeError('workspace must be an absolute path or null');
  }
  return value;
}

/** A prepared bundle's id as Core makes it: `diag-` and up to 32 hexadecimal digits. */
export function bundleId(value: unknown): string {
  if (typeof value !== 'string' || !/^diag-[0-9a-f]{1,32}$/.test(value)) {
    throw new TypeError('id must be a prepared diagnostic bundle id');
  }
  return value;
}

/** The client's versions for `versions.json`. */
export function appInfo(): Record<string, string> {
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
  };
}

/** `piarc-diagnostics-YYYYMMDD-HHMM.zip` in the Downloads folder. */
export function defaultBundlePath(now: Date, downloads: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return path.join(downloads, `piarc-diagnostics-${stamp}.zip`);
}

/** Registers the diagnostics page's bundle commands. */
export function registerDiagnosticsHandlers(
  registerHandler: RegisterHandler,
  core: DiagnosticsCore,
  translator: () => Translator,
  save: SavePort = electronSavePort,
  versions: () => Record<string, string> = appInfo,
): void {
  registerHandler(IPC_CHANNELS.diagnosticsPrepare, (_event, [dir]) =>
    core.prepareDiagnostics(workspaceArg(dir), JSON.stringify(versions())),
  );
  registerHandler(IPC_CHANNELS.diagnosticsExport, async (event, [raw]) => {
    const id = bundleId(raw);
    const target = await save.choosePath(
      event.sender,
      translator().t('diagnostics.bundle.saveTitle'),
    );
    if (target === null) return null;
    return core.exportDiagnostics(id, target);
  });
}
