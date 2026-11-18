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
import { FaultInjector, registerSessionHandlers } from './core/session-ipc.js';
import { installTestHooks } from './core/test-hooks.js';
import { applyDevServerCsp, resolveDevServer } from './dev-server.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import { createIpcRegistrar } from './ipc/register.js';
import { applyDataDirs, type DataDirs } from './platform/data-dirs.js';
import { PreferenceStore } from './preferences.js';
import { applyAppIdentity, quitsWhenAllWindowsClosed } from './platform/index.js';
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
const eventRouter = new EventRouter();
const terminalStats = { requests: 0, frames: 0, bytes: 0, errors: 0 };
const faults = new FaultInjector();

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
    attention: () => app.attention.observed(),
    failNext: (channel, message) => {
      faults.failNext(channel, message);
    },
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
  app.on('second-instance', () => {
    console.info('[app] second instance started; focusing the existing window');
    shell?.focusMain();
  });
  app.on('window-all-closed', () => {
    if (quitsWhenAllWindowsClosed) {
      app.quit();
    }
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
    });
    shell = appShell;
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
    const terminalOwners = new TerminalOwners(core.runtime);
    registerEventHandlers(registerHandler, eventRouter, (windowId, route) =>
      terminalOwners.mayObserve(windowId, route),
    );
    registerTerminalHandlers(registerHandler, core.runtime, terminalOwners, terminalStats);
    startTestHooks(core, terminalOwners, appShell);
    // The preferences come first: the window's language, theme and menu depend on them.
    void preferences.load().then(() => {
      appShell.start();
      appShell.openMain();
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
  start(dataDirs);
} else {
  console.info('[app] another instance is running; exiting');
  app.quit();
}
