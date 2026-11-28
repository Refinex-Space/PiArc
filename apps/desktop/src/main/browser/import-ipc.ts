// The settings page's browser commands (B5.1, B5.3, B5.5): Chrome profiles and sites, the
// import (native confirmation first), the imported sites with their removal, and clearing a
// workspace's browsing data. Arguments are checked here; Core checks them again.
import path from 'node:path';

import { BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import {
  isProfileId,
  isSite,
  sitesArg,
  workspaceArg,
  type ChromeImports,
  type ImportCore,
} from './chrome-import.js';

function profileArg(value: unknown): string {
  if (!isProfileId(value)) throw new TypeError('profile must be a Chrome profile name');
  return value;
}

function siteArg(value: unknown): string {
  if (!isSite(value)) throw new TypeError('site must be a site name');
  return value;
}

const workspace = (value: unknown) => workspaceArg(value, (p) => path.isAbsolute(p));

export function registerChromeImportHandlers(
  registerHandler: RegisterHandler,
  core: Pick<ImportCore, 'chromeProfiles' | 'chromeSites' | 'browserImports'>,
  imports: ChromeImports,
): void {
  registerHandler(IPC_CHANNELS.chromeProfiles, () => core.chromeProfiles());
  registerHandler(IPC_CHANNELS.chromeSites, (_event, [profile]) =>
    core.chromeSites(profileArg(profile)),
  );
  registerHandler(IPC_CHANNELS.chromeImport, async (event, [dir, profile, sites]) => {
    const outcome = await imports.import(
      BrowserWindow.fromWebContents(event.sender),
      workspace(dir),
      profileArg(profile),
      sitesArg(sites),
    );
    return JSON.stringify(outcome);
  });
  registerHandler(IPC_CHANNELS.browserImports, (_event, [dir]) =>
    core.browserImports(workspace(dir)),
  );
  registerHandler(IPC_CHANNELS.browserForgetImport, (_event, [dir, site]) =>
    imports.forget(workspace(dir), siteArg(site)),
  );
  registerHandler(IPC_CHANNELS.browserClearWorkspace, async (_event, [dir]) => {
    await imports.clearWorkspace(workspace(dir));
    return null;
  });
}
