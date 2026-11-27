// Main-process entry: app lifecycle and the security baseline of architecture section 10.3.
// Business logic does not belong here (ADR-0013); this file only wires modules together.
import path from 'node:path';
import { createRequire } from 'node:module';
import { diagramAssets } from './core/markdown-diagram.js';

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
import { DOCUMENT_SCHEME, ProjectPreviews } from './core/project-preview.js';
import { registerProjectWatch } from './core/project-file-watch.js';
import { registerMarkdownImageHandlers } from './core/markdown-images.js';
import { registerSessionImageHandlers } from './core/session-images.js';
import { registerProjectFileHandlers } from './core/project-files-ipc.js';
import { registerEventHandlers } from './core/event-ipc.js';
import { hasTestingExports } from './core/load.js';
import { EventRouter } from './core/router.js';
import { registerTerminalHandlers, TerminalOwners } from './core/terminal-ipc.js';
import { registerPermissionHandlers } from './core/permissions-ipc.js';
import { registerSandboxHandlers } from './core/sandbox-ipc.js';
import { registerUsageHandlers } from './core/usage-ipc.js';
import { registerDiagnosticsHandlers } from './core/diagnostics-ipc.js';
import { registerImageExportHandlers } from './core/image-export-ipc.js';
import { registerProxyHandlers, SystemProxy } from './core/proxy-ipc.js';
import { FaultInjector, registerSessionHandlers } from './core/session-ipc.js';
import { startupFailure } from './core/startup-error.js';
import { installTestHooks } from './core/test-hooks.js';
import { applyDevServerCsp, resolveDevServer } from './dev-server.js';
import { registerIpcHandlers } from './ipc/handlers.js';
import { createIpcRegistrar, registerHostHandler } from './ipc/register.js';
import { registerWorktreeHandlers } from './core/worktree-ipc.js';
import { registerMcpHandlers } from './core/mcp-ipc.js';
import { NativeConfirm, registerPackageHandlers } from './core/plugins-ipc.js';
import { registerGitHandlers } from './core/git-ipc.js';
import { URL_SCHEME, launchTargets, parseLaunchUrl } from './launch.js';
import { applyDataDirs, type DataDirs } from './platform/data-dirs.js';
import { PreferenceStore } from './preferences.js';
import { connectJumpList } from './platform/jump-list.js';
import { applyAppIdentity } from './platform/index.js';
import { confirmQuit } from './platform/quit.js';
import { TrayIcon, parseActivity, trayIconDirectory } from './platform/tray.js';
import { WindowStateFile } from './platform/window-state.js';
import { BROWSER_HOST_CHANNEL } from '../shared/browser-host.js';
import type { LaunchTarget } from '../shared/ipc.js';
import { resolveLocale, Translator } from '../shared/i18n/index.js';
import { runVelopackStartup } from './platform/velopack.js';
import { PRODUCTION_CSP } from './security/csp.js';
import { guardWebContents } from './security/navigation.js';
import { applyPermissionPolicy } from './security/permissions.js';
import { refuseRemoteDebugging } from './security/runtime-switches.js';
import { ToolWindows } from './tool-windows.js';
import { createMainWindow, createParkingWindow } from './window.js';
import { BROWSER_ROUTE } from './browser/agent-bridge.js';
import { startAgentRuntime, type AgentRuntime } from './browser/agent-runtime.js';
import { registerBrowserHandlers } from './browser/browser-ipc.js';
import { ChromeImports, persistentPartition } from './browser/chrome-import.js';
import { registerChromeImportHandlers } from './browser/import-ipc.js';
import { chromeUserAgent, refuseClientCertificates } from './browser/guest-session.js';
import { HOST_PAGE } from './browser/host-session.js';
import { HOST_SCHEME } from './browser/script-host.js';
import { BrowserService } from './browser/service.js';
import { BROWSE_SCHEME, WorkspaceFiles } from './browser/workspace-files.js';
import { electronExternalLinkPort } from './external-link-port.js';
import { LinkConfirmations } from './external-links.js';

// Release builds refuse Chromium's remote debugging before anything else runs (T45, I10): the
// switches are removed, so the DevTools server never starts, and the app exits.
if (__PIARC_RELEASE_BUILD__) {
  const refused = refuseRemoteDebugging(app.commandLine);
  if (refused.length > 0) {
    console.error(`[security] release builds do not accept --${refused.join(', --')}; exiting`);
    app.exit(1);
  }
}

// `import.meta.env.DEV` is a build-time constant: false in packaged builds, so the bundler
// drops every dev-server branch and the relaxed CSP never ships.
const devServer = import.meta.env.DEV
  ? resolveDevServer(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  : undefined;
const trustedOrigins: readonly string[] =
  devServer === undefined ? [APP_ORIGIN] : [APP_ORIGIN, devServer.origin];

let shell: AppShell | undefined;
let tray: TrayIcon | undefined;
/** The built-in browser (ADR-0088); exists once Core runs. */
let browser: BrowserService | undefined;
/** The agent's side of the browser (ADR-0089); exists once Core runs. */
let browserAgent: AgentRuntime | undefined;
/** Runs started by the development test hook `browserScript`. */
let testRuns = 0;
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
    // Core reads the language setting; before it runs, the system's language decides.
    const t = new Translator(resolveLocale('system', app.getPreferredSystemLanguages()));
    const failure = startupFailure(error, t);
    dialog.showErrorBox(failure.title, failure.message);
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
    browser: (sessionId) => {
      if (browser === undefined) return Promise.reject(new Error('The browser has not started'));
      return browser.observe(sessionId);
    },
    browserScript: async (sessionId, script, timeoutMs) => {
      if (browserAgent === undefined) throw new Error('The browser agent has not started');
      const answer = await browserAgent.hosts.run({
        runId: `test-${String(++testRuns)}`,
        sessionId,
        // No Core call: site cards are refused, so pages reach only allowed hosts.
        callSessionId: sessionId,
        toolCallId: `test-${String(testRuns)}`,
        script,
        timeoutMs: timeoutMs ?? 30_000,
      });
      if (answer === undefined) return null;
      return {
        output: answer.output,
        images: (answer.images ?? []).map(({ mediaType, width, height }) => ({
          mediaType,
          width,
          height,
        })),
        ...(answer.error == null
          ? {}
          : {
              error: {
                name: answer.error.name,
                message: answer.error.message,
                ...(answer.error.code == null ? {} : { code: answer.error.code }),
              },
            }),
        ...(answer.blockedHosts == null ? {} : { blockedHosts: answer.blockedHosts }),
      };
    },
    browserShare: async (sessionId, tabId) => {
      if (browserAgent === undefined) throw new Error('The browser agent has not started');
      return (await browserAgent.spaces.share(sessionId, tabId)) ?? null;
    },
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

/** The built-in browser: its service, the idle-page sweep and the cleanup at quit. */
function startBrowser(
  core: CoreHost,
  appShell: AppShell,
  dirs: DataDirs,
  toolWindows: ToolWindows,
  preferences: PreferenceStore,
): BrowserService {
  const links = new LinkConfirmations();
  const devPort = devServer === undefined ? undefined : Number(new URL(devServer.origin).port);
  const denied = new Set<number>(devPort === undefined || devPort === 0 ? [] : [devPort]);
  const service = new BrowserService({
    core: core.runtime,
    windows: () => appShell.mainWindows(),
    translator: () => appShell.t(),
    openExternal: (window, url) => {
      void links.open(window?.id ?? 0, url, electronExternalLinkPort(window, appShell.t()));
    },
    dataDir: path.join(dirs.data, 'browser'),
    platform: process.platform,
    deniedPorts: () => denied,
    createParking: createParkingWindow,
    files: new WorkspaceFiles(core.runtime),
    home: app.getPath('home'),
    toolWindow: (token, owner) => toolWindows.previewWindow(token, owner),
    // The user's settings (B5.5, `browser.*` of the user's settings file).
    preferences: () => {
      const chosen = preferences.get().browser;
      return {
        storage: chosen.storage,
        searchEngine: chosen.searchEngine,
        localHostnames: chosen.localHostnames,
        devtoolsDock: chosen.devtoolsDock,
        downloadDirectory: chosen.downloadDirectory,
      };
    },
  });
  // A changed DevTools dock (or other browser setting) applies to the open views at once.
  preferences.onChange(() => {
    service.preferencesChanged();
  });
  const sweep = setInterval(() => {
    service.discardIdle();
  }, 60_000);
  sweep.unref();
  app.on('before-quit', () => {
    service.quitting();
  });
  app.on('will-quit', () => {
    clearInterval(sweep);
    service.dispose();
  });
  return service;
}

/**
 * The agent's side of the browser (ADR-0089): script hosts answer `core/browser` runs. Core
 * offers the `Browser` tool only after `attachBrowserClient`, so it comes last.
 */
function startBrowserAgent(
  core: CoreHost,
  service: BrowserService,
  preferences: PreferenceStore,
  imports: ChromeImports,
): void {
  const hostDevServer = import.meta.env.DEV ? BROWSER_HOST_VITE_DEV_SERVER_URL : undefined;
  const agent = startAgentRuntime({
    service,
    core: core.runtime,
    hostFolder: bundlePath('renderer', BROWSER_HOST_VITE_NAME),
    hostPage: hostDevServer === undefined ? HOST_PAGE : `${hostDevServer}/index.html`,
    devOrigin: hostDevServer === undefined ? undefined : new URL(hostDevServer).origin,
    preload: bundlePath('build', 'browser-host.cjs'),
    devTools: !__PIARC_RELEASE_BUILD__,
    localNames: () => preferences.get().browser.localHostnames,
    // B5.4: hosts with imported Chrome sign-ins are sensitive for the agent.
    importedHost: async (sessionId, host) =>
      imports.covers((await service.agentModel(sessionId)).workspace, host),
    userAgent: chromeUserAgent(app.userAgentFallback),
    handedOff: () => {
      // The panel shows the hand-off from the Space's state (B2.5.3).
    },
    handedBack: (sessionId) => {
      // The agent asked the user to act in the browser; it goes on when the user says so.
      core.runtime
        .followUp(sessionId, shell?.t().t('browser.agent.handedBack') ?? '')
        .catch((error: unknown) => {
          console.warn('[browser] could not tell the agent the browser is back', error);
        });
    },
  });
  registerHostHandler(
    BROWSER_HOST_CHANNEL,
    (sender) => agent.hosts.isHost(sender),
    (sender, request) => agent.hosts.call(sender, request),
  );
  eventRouter.listen(BROWSER_ROUTE, (batch) => {
    agent.bridge.deliver(batch);
  });
  app.on('will-quit', () => {
    agent.hosts.dispose();
  });
  agent.bridge.attach();
  browserAgent = agent;
}

function start(dirs: DataDirs): void {
  let toolWindows: ToolWindows | undefined;
  let previews: ProjectPreviews | undefined;
  const previewFrame = (
    contents: Electron.WebContents,
    url: string,
    parent?: string,
    initiator?: string,
  ) =>
    previews?.allowsFrame(toolWindows?.fileOwner(contents) ?? contents, url, parent, initiator) ??
    false;
  app.on('session-created', (created) => {
    applyPermissionPolicy(created, trustedOrigins);
  });
  // Browser guests and the agent's script host are recognized by their partition when they
  // are created (ADR-0088 rule 2): they get the browser's guards, never the app's.
  refuseClientCertificates((contents) => browser?.isBrowserContents(contents) ?? false);
  app.on('web-contents-created', (_event, contents) => {
    if (browser?.isBrowserContents(contents) === true) return;
    contents.on('destroyed', () => browser?.released(contents));
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) browser?.released(contents);
    });
    guardWebContents(
      contents,
      trustedOrigins,
      (details) => toolWindows?.open(contents, details),
      (url, parent, initiator) => previewFrame(contents, url, parent, initiator),
      (from, to) =>
        previews?.followLink(contents, toolWindows?.fileOwner(contents) ?? contents, from, to),
    );
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
    connectJumpList(
      eventRouter,
      () => appShell.t(),
      (refresh) => {
        appShell.onLanguage(refresh);
      },
    );
    eventRouter.listen('core/activity', (batch) => {
      const activity = parseActivity(batch.payload);
      if (activity !== undefined) tray?.update(activity);
    });
    const registerHandler = createIpcRegistrar(trustedOrigins);
    registerIpcHandlers(registerHandler, () => appShell.t());
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
    registerDiagnosticsHandlers(registerHandler, core.runtime, () => appShell.t());
    registerImageExportHandlers(registerHandler, () => appShell.t());
    // ADR-0082: the system's proxy for the Agent Hosts, resolved now and as windows come forward.
    const systemProxy = new SystemProxy(core.runtime, session.defaultSession);
    systemProxy.detect().catch((error: unknown) => {
      console.warn('[proxy] resolving the system proxy failed', error);
    });
    app.on('browser-window-focus', () => {
      systemProxy.focused();
    });
    registerProxyHandlers(registerHandler, systemProxy);
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
    const diagramFolder = devServer
      ? path.join(app.getAppPath(), 'src', 'renderer', 'public', 'markdown-diagram')
      : bundlePath('renderer', MAIN_WINDOW_VITE_NAME, 'markdown-diagram');
    const diagramEngine = devServer
      ? createRequire(path.join(app.getAppPath(), 'package.json')).resolve(
          'mermaid/dist/mermaid.min.js',
        )
      : path.join(diagramFolder, 'engine.js');
    previews = new ProjectPreviews(core.runtime, diagramAssets(diagramFolder, diagramEngine));
    previews.register(registerHandler, terminalOwners);
    registerProjectWatch(registerHandler, core.runtime);
    registerMarkdownImageHandlers(registerHandler, core.runtime, terminalOwners, () =>
      appShell.t(),
    );
    registerSessionImageHandlers(registerHandler, dirs.data);
    registerProjectFileHandlers(registerHandler, core.runtime, terminalOwners, (child) =>
      toolWindows?.fileOwner(child),
    );
    toolWindows = new ToolWindows(
      terminalOwners,
      (sender) => appShell.mainWindows().some((win) => win.webContents === sender),
      async (sessionId) => {
        const metadata: unknown = JSON.parse(await core.runtime.sessionDeletionTarget(sessionId));
        return (
          typeof metadata === 'object' &&
          metadata !== null &&
          'workspace' in metadata &&
          typeof metadata.workspace === 'string'
        );
      },
    );
    toolWindows.allowFileFrame = previewFrame;
    toolWindows.register(registerHandler);
    // Every page is watched from its creation: terminal input needs the page's recent real
    // input (I51), so the first keystroke must already be seen.
    // A guest's input (including CDP's synthetic input) is never the workbench's real input.
    app.on('web-contents-created', (_event, contents) => {
      if (browser?.isBrowserContents(contents) === true) return;
      terminalOwners.watch(contents);
    });
    registerEventHandlers(registerHandler, eventRouter, (windowId, route) =>
      terminalOwners.mayObserve(windowId, route),
    );
    registerTerminalHandlers(registerHandler, core.runtime, terminalOwners, terminalStats);
    registerGitHandlers(
      registerHandler,
      core.runtime,
      () => appShell.t(),
      nativeConfirm,
      terminalOwners,
      () => preferences.locale(),
    );
    browser = startBrowser(core, appShell, dirs, toolWindows, preferences);
    registerBrowserHandlers(registerHandler, browser);
    // Chrome sign-in import (ADR-0090): native confirmation, then Core decrypts and the
    // cookies go into the workspace's persistent partition.
    const chromeImports = new ChromeImports({
      core: core.runtime,
      storage: () => preferences.get().browser.storage,
      translator: () => appShell.t(),
      confirm: nativeConfirm,
      platform: process.platform,
      partition: persistentPartition,
    });
    registerChromeImportHandlers(registerHandler, core.runtime, chromeImports);
    startBrowserAgent(core, browser, preferences, chromeImports);
    startTestHooks(core, terminalOwners, appShell);
    // The preferences come first: the window's language, theme and menu depend on them.
    void preferences.load().then(() => {
      appShell.start();
      const targets = [
        ...launchTargets(process.argv, process.defaultApp, process.cwd()),
        ...early.splice(0),
      ];
      const [first, ...rest] = targets;
      appShell.openMain(first ? [first] : []);
      for (const target of rest) appShell.launch(target);
    });
  });
}

// Velopack's install, update and uninstall hooks exit the process before anything else runs.
runVelopackStartup();

// Must run before `ready`: force the sandbox for every renderer and give the app scheme its
// privileges.
applyAppIdentity();
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  APP_SCHEME_REGISTRATION,
  DOCUMENT_SCHEME,
  BROWSE_SCHEME,
  // The agent's script host page (ADR-0089): a standard, secure origin of its own.
  { scheme: HOST_SCHEME, privileges: { standard: true, secure: true } },
]);
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
