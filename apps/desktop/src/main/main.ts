// Main-process entry: app lifecycle and the security baseline of architecture section 10.3.
// Business logic does not belong here (ADR-0013); this file only wires modules together.
import path from 'node:path';

import { app, BrowserWindow, dialog, protocol, session } from 'electron';

import { APP_ENTRY_URL, APP_ORIGIN } from './app-scheme.js';
import { APP_SCHEME_REGISTRATION, registerAppProtocol } from './app-protocol.js';
import { shutdownCoreBeforeQuit, startCore, type CoreHost } from './core/core-host.js';
import { registerEventHandlers } from './core/event-ipc.js';
import { hasTestingExports } from './core/load.js';
import { EventRouter } from './core/router.js';
import { registerTerminalHandlers, TerminalOwners } from './core/terminal-ipc.js';
import { installTestHooks } from './core/test-hooks.js';
import { applyDevServerCsp, resolveDevServer } from './dev-server.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import { createIpcRegistrar } from './ipc/register.js';
import { applyAppIdentity, quitsWhenAllWindowsClosed } from './platform/index.js';
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

let mainWindow: BrowserWindow | null = null;
const eventRouter = new EventRouter();
const terminalStats = { requests: 0, frames: 0, bytes: 0, errors: 0 };

function bundlePath(...segments: string[]): string {
  return path.join(app.getAppPath(), '.vite', ...segments);
}

function openWindow(hash = ''): BrowserWindow {
  const window = createMainWindow(bundlePath('build', 'preload.cjs'));
  void window.loadURL(`${devServer?.url ?? APP_ENTRY_URL}${hash}`);
  return window;
}

function openMainWindow(): void {
  const window = openWindow();
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
}

/** Loads and starts Core; on failure tells the user and exits. */
function startCoreOrExit(): CoreHost | undefined {
  try {
    return startCore(
      {
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        platform: process.platform,
        arch: process.arch,
      },
      eventRouter,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[core] failed to start: ${reason}`);
    dialog.showErrorBox('PiArc could not start', `PiArc Core failed to load.\n\n${reason}`);
    app.exit(1);
    return undefined;
  }
}

function startTestHooks(core: CoreHost, terminalOwners: TerminalOwners): void {
  if (!hasTestingExports(core.runtime)) {
    return;
  }
  installTestHooks({
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

function focusMainWindow(): void {
  if (mainWindow === null) {
    openMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function start(): void {
  app.on('session-created', (created) => {
    applyPermissionPolicy(created, trustedOrigins);
  });
  app.on('web-contents-created', (_event, contents) => {
    guardWebContents(contents, trustedOrigins);
  });
  app.on('second-instance', () => {
    console.info('[app] second instance started; focusing the existing window');
    focusMainWindow();
  });
  app.on('window-all-closed', () => {
    if (quitsWhenAllWindowsClosed) {
      app.quit();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openMainWindow();
    }
  });

  void app.whenReady().then(() => {
    applyPermissionPolicy(session.defaultSession, trustedOrigins);
    registerAppProtocol(bundlePath('renderer', MAIN_WINDOW_VITE_NAME), PRODUCTION_CSP);
    if (import.meta.env.DEV && devServer !== undefined) {
      applyDevServerCsp(session.defaultSession, devServer);
    }
    const core = startCoreOrExit();
    if (core === undefined) {
      return;
    }
    shutdownCoreBeforeQuit(app, core.runtime);
    const registerHandler = createIpcRegistrar(trustedOrigins);
    registerIpcHandlers(registerHandler);
    registerEventHandlers(registerHandler, eventRouter);
    const terminalOwners = new TerminalOwners(core.runtime);
    registerTerminalHandlers(registerHandler, core.runtime, terminalOwners, terminalStats);
    startTestHooks(core, terminalOwners);
    openMainWindow();
  });
}

// Must run before `ready`: force the sandbox for every renderer and give the app scheme its
// privileges.
applyAppIdentity();
app.enableSandbox();
protocol.registerSchemesAsPrivileged([APP_SCHEME_REGISTRATION]);

if (app.requestSingleInstanceLock()) {
  start();
} else {
  console.info('[app] another instance is running; exiting');
  app.quit();
}
