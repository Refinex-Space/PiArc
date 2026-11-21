// Main-process entry: app lifecycle and the security baseline of architecture section 10.3.
// Business logic does not belong here (ADR-0013); this file only wires modules together.
import path from 'node:path';

import { app, BrowserWindow, dialog, protocol, session } from 'electron';

import { APP_ENTRY_URL, APP_ORIGIN } from './app-scheme.js';
import { APP_SCHEME_REGISTRATION, registerAppProtocol } from './app-protocol.js';
import { AppShell } from './app-shell.js';
import {
  MEMORY_KEYCHAIN_ENV,
  shutdownCoreBeforeQuit,
  startCore,
  type CoreHost,
} from './core/core-host.js';
import { registerEventHandlers } from './core/event-ipc.js';
import { hasTestingExports } from './core/load.js';
import { EventRouter } from './core/router.js';
import { registerTerminalHandlers, TerminalOwners } from './core/terminal-ipc.js';
import { registerPermissionHandlers } from './core/permissions-ipc.js';
import { registerSandboxHandlers } from './core/sandbox-ipc.js';
import { registerUsageHandlers } from './core/usage-ipc.js';
import { FaultInjector, registerSessionHandlers } from './core/session-ipc.js';
import { installTestHooks } from './core/test-hooks.js';
import { applyDevServerCsp, resolveDevServer } from './dev-server.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import { createIpcRegistrar } from './ipc/register.js';
import { registerWorktreeHandlers } from './core/worktree-ipc.js';
import { registerMcpHandlers } from './core/mcp-ipc.js';
import { NativeConfirm, registerPackageHandlers } from './core/plugins-ipc.js';
import { URL_SCHEME, launchTargets, parseLaunchUrl } from './launch.js';
import { applyDataDirs, type DataDirs } from './platform/data-dirs.js';
import { PreferenceStore } from './preferences.js';
import { applyAppIdentity } from './platform/index.js';
import { confirmQuit } from './platform/quit.js';
import { TrayIcon, parseActivity, trayIconDirectory } from './platform/tray.js';
import { WindowStateFile } from './platform/window-state.js';
import type { LaunchTarget } from '../shared/ipc.js';
import { runVelopackStartup } from './platform/velopack.js';
import { PRODUCTION_CSP } from './security/csp.js';
import { guardWebContents } from './security/navigation.js';
import { applyPermissionPolicy } from './security/permissions.js';
import { createMainWindow } from './window.js';

// `import.meta.env.DEV` is a build-time constant: false in packaged builds, so the bundler
// drops every dev-server branch and the relaxed CSP never ships.
const devServer = import.meta.env.DEV
  ? resolveDevServer(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  : undefined;
const trustedOrigins: readonly string[] =
  devServer === undefined ? [APP_ORIGIN] : [APP_ORIGIN, devServer.origin];

let shell: AppShell | undefined;
let tray: TrayIcon | undefined;
const eventRouter = new EventRouter();
/** Launch targets that arrived before the shell existed (macOS sends them before `ready`). */
const early: LaunchTarget[] = [];

function launch(target: LaunchTarget | undefined): void {
  if (target === undefined) return;
  if (shell === undefined) early.push(target);
  else shell.launch(target);
}
const terminalStats = { requests: 0, frames: 0, bytes: 0, errors: 0 };
const faults = new FaultInjector();
/** Native confirmations that development builds' test hooks may answer (T40). */
const nativeConfirm = new NativeConfirm();

function bundlePath(...segments: string[]): string {
  return path.join(app.getAppPath(), '.vite', ...segments);
}

/** A window on another page of the app (test pages through the test hooks). */
function openWindow(hash: string): BrowserWindow {
  const window = createMainWindow(bundlePath('build', 'preload.cjs'));
  void window.loadURL(`${entryUrl()}${hash}`);
  return window;
}

function entryUrl(): string {
  return devServer?.url ?? APP_ENTRY_URL;
}

/** Loads and starts Core; on failure tells the user and exits. */
function startCoreOrExit(dirs: DataDirs): CoreHost | undefined {
  try {
    return startCore(
      {
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        platform: process.platform,
        arch: process.arch,
        resourcesPath: process.resourcesPath,
      },
      eventRouter,
      { dataDir: dirs.data, cacheDir: dirs.cache },
      process.env[MEMORY_KEYCHAIN_ENV] === '1',
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[core] failed to start: ${reason}`);
    dialog.showErrorBox('PiArc could not start', `PiArc Core failed to load.\n\n${reason}`);
    app.exit(1);
    return undefined;
  }
}

function startTestHooks(core: CoreHost, terminalOwners: TerminalOwners, app: AppShell): void {
  if (!hasTestingExports(core.runtime)) {
    return;
  }
  installTestHooks({
    tray: () => tray?.observe(),
    launch: (target) => {
      launch(target);
    },
    quit: () => {
      app.run('app.quit');
    },
    mainWindows: () => app.mainWindows().map((w) => w.webContents.id),
    attention: () => app.attention.observed(),
    notificationAction: (index) => app.attention.pressAction(index),
    failNext: (channel, message) => {
      faults.failNext(channel, message);
    },
    holdNext: (channel, ms) => {
      faults.holdNext(channel, ms);
    },
    answerConfirm: (answer) => {
      nativeConfirm.answerNext(answer);
    },
    confirmations: () => nativeConfirm.shown(),
    modulePath: core.modulePath,
    core: core.runtime,
    router: eventRouter,
    terminalOwners,
    terminalStats,
    openWindow: async (hash) => {
      const window = openWindow(hash);
      await new Promise<void>((resolve) => window.webContents.once('did-finish-load', resolve));
      return window.webContents.id;
    },
  });
}

function start(dirs: DataDirs): void {
  app.on('session-created', (created) => {
    applyPermissionPolicy(created, trustedOrigins);
  });
  app.on('web-contents-created', (_event, contents) => {
    guardWebContents(contents, trustedOrigins);
  });
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const targets = launchTargets(argv, process.defaultApp, workingDirectory);
    if (targets.length === 0) {
      console.info('[app] second instance started; focusing the existing window');
      shell?.focusMain();
      return;
    }
    console.info(`[app] second instance started with ${String(targets.length)} targets`);
    for (const target of targets) launch(target);
  });
  // Closing the last window leaves PiArc running in the menu bar or tray: sessions and
  // background tasks go on (architecture section 3.3). Quitting is the tray's or the menu's.
  app.on('window-all-closed', () => {
    console.info('[app] no window open; running in the background');
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      shell?.openMain();
    }
  });

  void app.whenReady().then(() => {
    applyPermissionPolicy(session.defaultSession, trustedOrigins);
    registerAppProtocol(bundlePath('renderer', MAIN_WINDOW_VITE_NAME), PRODUCTION_CSP);
    if (import.meta.env.DEV && devServer !== undefined) {
      applyDevServerCsp(session.defaultSession, devServer);
    }
    const core = startCoreOrExit(dirs);
    if (core === undefined) {
      return;
    }
    shutdownCoreBeforeQuit(app, core.runtime);
    const preferences = new PreferenceStore(core.runtime, () => app.getPreferredSystemLanguages());
    const appShell = new AppShell({
      preloadPath: bundlePath('build', 'preload.cjs'),
      entryUrl: entryUrl(),
      preferences,
      developer: import.meta.env.DEV || hasTestingExports(core.runtime),
      windowState: WindowStateFile.in(app.getPath('userData')),
      quit: () => {
        void confirmQuit(core.runtime, () => appShell.t());
      },
    });
    shell = appShell;
    tray = new TrayIcon(
      process.platform,
      trayIconDirectory(app.isPackaged, process.resourcesPath, app.getAppPath()),
      () => appShell.t(),
      {
        open: () => appShell.focusMain(),
        newWindow: () => appShell.openMain(),
        openSession: (id) => {
          appShell.launch({ kind: 'session', sessionId: id });
        },
        quit: () => {
          appShell.run('app.quit');
        },
      },
    );
    appShell.onLanguage(() => tray?.refresh());
    eventRouter.listen('core/activity', (batch) => {
      const activity = parseActivity(batch.payload);
      if (activity !== undefined) tray?.update(activity);
    });
    const registerHandler = createIpcRegistrar(trustedOrigins);
    registerIpcHandlers(registerHandler);
    appShell.registerHandlers(registerHandler);
    registerSessionHandlers(
      registerHandler,
      core.runtime,
      () => appShell.t(),
      faults,
      () => {
        appShell.providersChanged();
      },
    );
    registerPermissionHandlers(registerHandler, core.runtime, () => appShell.t());
    // T42: notification buttons answer through the same ledger as the card.
    appShell.attention.connect({ answer: (json) => core.runtime.answerApproval(json) });
    registerSandboxHandlers(registerHandler, core.runtime, () => appShell.t());
    registerUsageHandlers(registerHandler, core.runtime);
    registerMcpHandlers(registerHandler, core.runtime);
    registerPackageHandlers(registerHandler, core.runtime, () => appShell.t(), nativeConfirm);
    registerWorktreeHandlers(
      registerHandler,
      core.runtime,
      () => appShell.t(),
      (id) => {
        appShell.openSessionWindow(id);
      },
    );
    const terminalOwners = new TerminalOwners(core.runtime);
    // Every page is watched from its creation: terminal input needs the page's recent real
    // input (I51), so the first keystroke must already be seen.
    app.on('web-contents-created', (_event, contents) => {
      terminalOwners.watch(contents);
    });
    registerEventHandlers(registerHandler, eventRouter, (windowId, route) =>
      terminalOwners.mayObserve(windowId, route),
    );
    registerTerminalHandlers(registerHandler, core.runtime, terminalOwners, terminalStats);
    startTestHooks(core, terminalOwners, appShell);
    // The preferences come first: the window's language, theme and menu depend on them.
    void preferences.load().then(() => {
      appShell.start();
      const targets = [
        ...launchTargets(process.argv, process.defaultApp, process.cwd()),
        ...early.splice(0),
      ];
      appShell.openMain(targets);
    });
  });
}

// Velopack's install, update and uninstall hooks exit the process before anything else runs.
runVelopackStartup();

// Must run before `ready`: force the sandbox for every renderer and give the app scheme its
// privileges.
applyAppIdentity();
app.enableSandbox();
protocol.registerSchemesAsPrivileged([APP_SCHEME_REGISTRATION]);
// Before `ready` and before the single-instance lock, which lives in `userData`.
const dataDirs = applyDataDirs(app, process.env, process.platform);

if (app.requestSingleInstanceLock()) {
  // macOS delivers links and Dock drops as events, possibly before `ready`.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    launch(parseLaunchUrl(url));
  });
  app.on('open-file', (event, file) => {
    event.preventDefault();
    launch(launchTargets(['', file], false, '/')[0]);
  });
  // The installed app answers `piarc://` (packaged: macOS declares it in Info.plist, the
  // Windows installer registers it, ADR-0052); a development run does not claim the scheme.
  if (app.isPackaged) app.setAsDefaultProtocolClient(URL_SCHEME);
  start(dataDirs);
} else {
  console.info('[app] another instance is running; exiting');
  app.quit();
}
