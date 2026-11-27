// A07, A08, A09: the page sees exactly the `window.piarc` allowlist, no Electron or Node
// objects, and the main process answers IPC only from the app origin.
import type { ElectronApplication } from '@playwright/test';

import { expect, test } from './fixtures.js';

/** The `window.piarc` allowlist. Changing it is a security review item (apps/desktop/CLAUDE.md). */
const PIARC_API_SNAPSHOT = [
  'abort',
  'answerApproval',
  'answerLogin',
  'askSideChat',
  'auditEvents',
  'browserImports',
  'cancelFileSearch',
  'cancelGit',
  'checkPermissionRule',
  'chooseFolder',
  'chromeImport',
  'chromeProfiles',
  'chromeSites',
  'clearBrowserData',
  'closeSession',
  'closeTerminal',
  'compact',
  'composerInfo',
  'configDiagnostics',
  'confirmPackage',
  'contextUsage',
  'controlSideChat',
  'createDraftSession',
  'createSession',
  'decideProjectTrust',
  'deleteProvider',
  'deleteQueueItem',
  'deleteSession',
  'detectProxy',
  'dictationCancel',
  'dictationStart',
  'dictationStatus',
  'dictationStop',
  'discardChange',
  'discardDraftSession',
  'discoverModels',
  'editQueueItem',
  'exportDiagnostics',
  'focusDictationOwner',
  'followUp',
  'forgetBrowserImport',
  'forkSession',
  'getAppState',
  'getAppVersion',
  'git',
  'ignoreWorktrees',
  'installPackage',
  'keepSessionWorktree',
  'listAgents',
  'listCommands',
  'listPackages',
  'listSkills',
  'logoutProvider',
  'managedSettings',
  'markSessionRead',
  'markdownImage',
  'markdownImageSettings',
  'marketDetail',
  'marketInstall',
  'marketQuery',
  'marketRefresh',
  'mcpAddServer',
  'mcpLogin',
  'mcpReconnect',
  'mcpSetEnabled',
  'mcpStatus',
  'memoryEdit',
  'memoryView',
  'notifyAttention',
  'onAppEvent',
  'openExternal',
  'openMicrophoneSettings',
  'openSessionTerminal',
  'openSessionWindow',
  'openSettings',
  'openWorkspace',
  'pathForFile',
  'permissionRules',
  'pinToolWindow',
  'prepareDiagnostics',
  'prepareToolWindow',
  'previewModelSwitch',
  'projectFileAction',
  'projectFilePreview',
  'projectFiles',
  'projectTrust',
  'prompt',
  'providerSettings',
  'readTaskOutput',
  'removeProviderAccount',
  'removeSessionWorktree',
  'removeWorkspace',
  'renameSession',
  'requestTerminalFrame',
  'resendSnapshots',
  'resumeSession',
  'revealMemory',
  'rewind',
  'rewindPreview',
  'sandboxSettings',
  'saveImage',
  'saveProvider',
  'searchFiles',
  'searchSessions',
  'sessionChanges',
  'sessionImage',
  'sessionModels',
  'sessionUsage',
  'setAttentionCount',
  'setCatalogRefresh',
  'setModelPreferences',
  'setModelPrice',
  'setOutputStyle',
  'setPackageEnabled',
  'setPermissionMode',
  'setPreference',
  'setProviderEnabled',
  'setSandboxSettings',
  'setSessionArchived',
  'setSessionEffort',
  'setSessionModel',
  'setSessionPinned',
  'setWebSearchBackend',
  'setWebSearchKey',
  'shareTerminal',
  'speechDevices',
  'speechModelAction',
  'speechModels',
  'startLogin',
  'steer',
  'stopSubagent',
  'stopTask',
  'storeAttachment',
  'subagentTranscript',
  'subscribeEvents',
  'switchBranch',
  'takeLaunchTargets',
  'terminalClearSelection',
  'terminalColors',
  'terminalFocus',
  'terminalInfo',
  'terminalInput',
  'terminalKey',
  'terminalLinkAt',
  'terminalMouse',
  'terminalPaste',
  'terminalResize',
  'terminalScreenText',
  'terminalScroll',
  'terminalSearch',
  'terminalSelectionText',
  'testProvider',
  'transcriptWindow',
  'undoRewind',
  'uninstallPackage',
  'unsubscribeEvents',
  'updatePackage',
  'updatePermissionRule',
  'usageReport',
  'useProviderAccount',
  'watchProjectFiles',
  'webSearchSettings',
  'workspaceModels',
  'worktreeBranches',
];

test('window.piarc exposes exactly the allowlisted functions', async ({ page }) => {
  const shape = await page.evaluate(() =>
    Object.entries(Object.getOwnPropertyDescriptors(window.piarc))
      .map(([key, descriptor]) => `${key}: ${typeof descriptor.value}`)
      .sort(),
  );
  expect(shape).toEqual(PIARC_API_SNAPSHOT.map((key) => `${key}: function`));
});

test('the page cannot reach ipcRenderer or other Electron objects', async ({ page }) => {
  const findings = await page.evaluate(() => {
    const found: string[] = [];
    for (const name of Object.getOwnPropertyNames(window)) {
      if (/ipc|electron/i.test(name)) {
        found.push(`window.${name}`);
      }
      let value: unknown;
      try {
        value = (window as unknown as Record<string, unknown>)[name];
      } catch {
        continue;
      }
      if (typeof value === 'object' && value !== null) {
        for (const key of ['ipcRenderer', 'sendSync', 'contextBridge', 'webFrame']) {
          if (key in value) {
            found.push(`window.${name}.${key}`);
          }
        }
      }
    }
    return found;
  });
  expect(findings).toEqual([]);
});

test('require, process, module and Buffer are not defined in the page', async ({ page }) => {
  const types = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>).require,
    process: typeof (globalThis as Record<string, unknown>).process,
    module: typeof (globalThis as Record<string, unknown>).module,
    Buffer: typeof (globalThis as Record<string, unknown>).Buffer,
  }));
  expect(types).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    Buffer: 'undefined',
  });
});

test('the window renderer runs in the OS-level sandbox', async ({ app }) => {
  // `sandboxed` is reported on macOS and Windows, the two platforms PiArc ships. The other
  // fixed web preferences are covered by src/main/web-preferences.test.ts and the ESLint rule
  // that confines `new BrowserWindow` to the window factory. Right after launch (slow CI
  // machines) the window or its renderer's metric may not exist yet: wait for the metric, then
  // require `sandboxed` to be true (a missing metric never passes).
  const readSandboxed = () =>
    app.evaluate(({ app: electronApp, BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
      if (pid === undefined || pid === 0) return null;
      return electronApp.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed ?? null;
    });
  await expect.poll(readSandboxed, { timeout: 10_000 }).not.toBeNull();
  expect(await readSandboxed()).toBe(true);
});

/**
 * Opens a hidden window with the app's preload on `url` (outside the window factory on
 * purpose, to get a frame of another origin) and calls `window.piarc.getAppVersion()` there.
 */
async function callFromForeignOrigin(app: ElectronApplication, url: string): Promise<string> {
  return app.evaluate(async ({ app: electronApp, BrowserWindow }, target) => {
    // The app path is the source tree in the dev form and app.asar in the packaged form.
    const preload = [electronApp.getAppPath(), '.vite', 'build', 'preload.cjs'].join('/');
    const probe = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    });
    try {
      await probe.loadURL(target).catch(() => undefined);
      const outcome: unknown = await probe.webContents.executeJavaScript(
        `typeof window.piarc === 'object'
            ? window.piarc.getAppVersion().then((v) => 'resolved ' + v, (e) => 'rejected ' + e.message)
            : Promise.resolve('no window.piarc')`,
      );
      return String(outcome);
    } finally {
      probe.destroy();
    }
  }, url);
}

test('IPC from the app origin is answered', async ({ page }) => {
  await expect(page.evaluate(() => window.piarc.getAppVersion())).resolves.toMatch(
    /^\d+\.\d+\.\d+/,
  );
});

test('IPC from another origin is rejected', async ({ app, appLog }) => {
  const outcome = await callFromForeignOrigin(app, 'data:text/html,<p>foreign</p>');
  expect(outcome).toMatch(/^rejected .*untrusted sender/);
  await appLog.waitFor(/\[ipc\] rejected piarc:app\.getVersion from null/);
});

test('IPC from an origin that only starts with the app origin is rejected', async ({
  app,
  appLog,
}) => {
  const outcome = await callFromForeignOrigin(app, 'app://piarcx/index.html');
  expect(outcome).toMatch(/^rejected .*untrusted sender/);
  await appLog.waitFor(/\[ipc\] rejected piarc:app\.getVersion from app:\/\/piarcx/);
});
