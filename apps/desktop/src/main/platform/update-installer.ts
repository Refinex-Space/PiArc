// The platform side of installing an update (ADR-0111 rules 5–7) and the About page's
// versions. `createInstaller` wires the macOS and Windows steps to Electron and Node.
import { execFile, spawn } from 'node:child_process';
import { constants, openSync } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

import type { Translator } from '../../shared/i18n/index.js';
import type { AboutInfo, UpdateInstallOutcome } from '../../shared/ipc.js';
import { APP_IDENTIFIER } from '../app-identity.js';
import type { InstallPlan, Installer } from '../core/updates-ipc.js';
import {
  bundleOf,
  replaceable,
  stageMacUpdate,
  startSwap,
  type MacInstallPorts,
} from './mac-update.js';
import { mayQuit } from './quit.js';
import { applyWindowsUpdate, velopackManager } from './windows-update.js';

const MAC_PORTS: MacInstallPorts = {
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, [...args], { encoding: 'utf8' }, (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout });
      });
    }),
  writable: async (target) => {
    try {
      await access(target, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  removeDir: (dir) => rm(dir, { recursive: true, force: true }),
  makeDir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: (file, text) => writeFile(file, text, { mode: 0o700 }),
  spawnDetached: (command, args, log) => {
    const out = openSync(log, 'a');
    spawn(command, [...args], { detached: true, stdio: ['ignore', out, out] }).unref();
  },
};

async function installMac(plan: InstallPlan & { platform: 'macos' }, logDir: string) {
  const bundle = bundleOf(app.getPath('exe'));
  const reason = await replaceable(bundle, MAC_PORTS.writable);
  if (reason !== undefined || bundle === undefined) {
    return { kind: 'manual', reason: reason ?? 'notBundle' } as const;
  }
  const staged = await stageMacUpdate(MAC_PORTS, {
    archive: plan.archive,
    bundle,
    version: plan.version,
    identifier: APP_IDENTIFIER,
  });
  await mkdir(logDir, { recursive: true });
  await startSwap(MAC_PORTS, {
    pid: process.pid,
    app: staged,
    bundle,
    log: path.join(logDir, 'install.log'),
  });
  return { kind: 'restarting' } as const;
}

/** The installer of a packaged app; a source-tree run installs nothing. */
export function createInstaller(options: {
  readonly core: { runningWork(): string };
  readonly translator: () => Translator;
  /** Core's cache directory (`updates/install.log` goes below it). */
  readonly cacheDir: string;
}): Installer {
  return {
    confirmQuit: () => mayQuit(options.core, options.translator),
    install: async (plan): Promise<UpdateInstallOutcome> => {
      if (!app.isPackaged) return { kind: 'manual', reason: 'unsupported' };
      if (plan.platform === 'macos' && process.platform === 'darwin') {
        return installMac(plan, path.join(options.cacheDir, 'updates'));
      }
      if (plan.platform === 'windows' && process.platform === 'win32') {
        const outcome = await applyWindowsUpdate(
          () => velopackManager(app.getAppPath(), plan.feed),
          plan.version,
        );
        return outcome === 'applying'
          ? { kind: 'restarting' }
          : { kind: 'manual', reason: 'notInstalled' };
      }
      return { kind: 'manual', reason: 'unsupported' };
    },
    quit: () => {
      app.quit();
    },
  };
}

/** Versions of the parts PiArc is built from, fixed at build time. */
export interface BuiltComponents {
  readonly pi: string;
  readonly protocol: string;
  readonly ghostty: string;
}

/** The About page's versions. */
export function aboutInfo(
  components: BuiltComponents,
  release: boolean,
  versions: NodeJS.ProcessVersions = process.versions,
): AboutInfo {
  return {
    app: app.getVersion(),
    electron: versions.electron,
    chromium: versions.chrome,
    node: versions.node,
    pi: components.pi,
    protocol: components.protocol,
    ghostty: components.ghostty,
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion(),
    release,
  };
}
