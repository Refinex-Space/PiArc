// T45-A11 (THR-11): what a page that runs injected script can do with `window.piarc`.
// 1. Every command, called with malformed arguments, settles with a structured error (the
//    main process's validation, `Error invoking remote method '<channel>': <Class>: <reason>`)
//    or, for a command without parameters, ignores them; nothing hangs and the main process
//    keeps answering.
// 2. Saving an allow rule, answering "always allow" and loosening the sandbox stop at the main
//    process's native confirmation: cancelled there, nothing changes; confirmed, the change
//    lands (the control that the confirmation is the gate).
import type { ElectronApplication, Page } from '@playwright/test';

import { expect, makeWorkspace, openFolder, stubMessageBox, test } from './sessions.js';

/** Commands without parameters: extra arguments are ignored (src/shared/ipc.ts). */
const NO_PARAMETERS = new Set([
  'getAppVersion',
  'getAppState',
  'chooseFolder',
  'providerSettings',
  'composerInfo',
  'webSearchSettings',
  'managedSettings',
  'resendSnapshots',
  'takeLaunchTargets',
  'detectProxy',
  // The Pi package market (ADR-0102): refreshing takes no parameters.
  'marketRefresh',
  // Voice dictation (ADR-0094).
  'dictationStatus',
  'speechDevices',
  'speechModels',
  'openMicrophoneSettings',
  'focusDictationOwner',
  // Data management: the export asks where in the native save dialog (stubbed: cancelled).
  'exportData',
  'revealDataExport',
  // Chrome sign-in import (ADR-0090) and Pi's global instructions (ADR-0108).
  'chromeProfiles',
  'piInstructions',
  // In-app updates (ADR-0111): the page chooses no file, URL or version.
  'updateStatus',
  'checkForUpdates',
  'downloadUpdate',
  'cancelUpdateDownload',
  'installUpdate',
  'aboutInfo',
]);

/** Synchronous preload functions (no IPC round trip). */
const SYNCHRONOUS = new Set(['onAppEvent', 'pathForFile']);

/**
 * Functions the preload checks itself before any IPC (a listener must be a function, a file a
 * File). Their error crosses the context bridge as a plain `Error` with the preload's reason.
 */
const PRELOAD_CHECKED = new Set(['subscribeEvents', 'onAppEvent', 'pathForFile']);

const STRUCTURED =
  /^(Error invoking remote method 'piarc:[A-Za-z.]+': [A-Za-z]*Error: .+|Unexpected IPC result: .+)$/su;

interface Outcome {
  readonly name: string;
  readonly set: number;
  readonly kind: 'resolved' | 'rejected' | 'threw' | 'timeout';
  /** The error's class (`TypeError` for the preload's own checks). */
  readonly error: string;
  readonly message: string;
}

/** Stubs every native dialog a command could open: cancelled. */
async function stubDialogs(app: ElectronApplication): Promise<void> {
  await stubMessageBox(app, 1);
  await app.evaluate(({ dialog, shell }) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: true, filePaths: [] });
    dialog.showSaveDialog = () => Promise.resolve({ canceled: true, filePath: '' });
    shell.openExternal = () => Promise.resolve();
  });
}

/** Calls every command of `window.piarc` with each malformed argument list. */
function sweep(page: Page): Promise<Outcome[]> {
  return page.evaluate(
    async ({ synchronous }) => {
      const api = window.piarc as unknown as Record<string, unknown>;
      const proto = Object.create({ polluted: true }) as Record<string, unknown>;
      const sets: unknown[][] = [
        [],
        [null],
        [42],
        [{}],
        [[1, 2, 3]],
        ['x'.repeat(200_000)],
        [proto, -1, { nested: { deep: [null] } }],
      ];
      const outcomes: Outcome[] = [];
      for (const name of Object.keys(api).sort()) {
        const fn = api[name];
        if (typeof fn !== 'function') continue;
        for (const [set, args] of sets.entries()) {
          if (synchronous.includes(name)) {
            try {
              (fn as (...a: unknown[]) => unknown)(...args);
              outcomes.push({ name, set, kind: 'resolved', error: '', message: '' });
            } catch (error) {
              const e = error instanceof Error ? error : new Error(String(error));
              outcomes.push({ name, set, kind: 'threw', error: e.name, message: e.message });
            }
            continue;
          }
          const call = Promise.resolve().then(() => (fn as (...a: unknown[]) => unknown)(...args));
          const timeout = new Promise<'timeout'>((resolve) =>
            setTimeout(() => {
              resolve('timeout');
            }, 10_000),
          );
          try {
            const result = await Promise.race([call, timeout]);
            outcomes.push({
              name,
              set,
              kind: result === 'timeout' ? 'timeout' : 'resolved',
              error: '',
              message: '',
            });
          } catch (error) {
            const e = error instanceof Error ? error : new Error(String(error));
            outcomes.push({ name, set, kind: 'rejected', error: e.name, message: e.message });
          }
        }
      }
      return outcomes;
    },
    { synchronous: [...SYNCHRONOUS] },
  );
}

test('THR-11 every window.piarc command answers malformed arguments with a structured error and the main process lives', async ({
  app,
  page,
  appLog,
}) => {
  test.setTimeout(180_000);
  await stubDialogs(app);
  const outcomes = await sweep(page);
  const names = new Set(outcomes.map((o) => o.name));
  expect(names.size).toBeGreaterThan(100);

  expect(outcomes.filter((o) => o.kind === 'timeout')).toEqual([]);
  // Refused by the main process (the IPC error carries the channel and the class) or by the
  // preload's own checks before any IPC (a reason, whatever class the bridge left).
  const structured = (o: Outcome) =>
    STRUCTURED.test(o.message) || (PRELOAD_CHECKED.has(o.name) && o.message !== '');
  const malformed = outcomes.filter(
    (o) => (o.kind === 'rejected' || o.kind === 'threw') && !structured(o),
  );
  expect(malformed).toEqual([]);
  const neverRejected = [...names].filter(
    (name) =>
      !NO_PARAMETERS.has(name) &&
      !outcomes.some((o) => o.name === name && (o.kind === 'rejected' || o.kind === 'threw')),
  );
  expect(neverRejected).toEqual([]);

  // The main process still answers, and logged no uncaught failure.
  expect(await app.evaluate(() => process.pid)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.piarc.getAppVersion())).toMatch(/^\d+\.\d+\.\d+/u);
  expect(appLog.text()).not.toMatch(/Uncaught|UnhandledPromiseRejection|FATAL/u);
  console.log(
    `THR-11: ${String(names.size)} commands × 7 malformed argument lists, ${String(outcomes.filter((o) => o.kind !== 'resolved').length)} structured refusals, no hang`,
  );
});

test('THR-11 allow rules, always-allow answers and sandbox loosening from the page wait for the native confirmation', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(90_000);
  const ws = await makeWorkspace(workspaces, 'hardening 加固');
  await openFolder(page, app, ws);
  await stubMessageBox(app, 1);
  const forged = await page.evaluate(async (dir) => {
    const rule = await window.piarc.updatePermissionRule({
      workspace: dir,
      layer: 'user',
      behavior: 'allow',
      rule: 'Bash(curl *)',
    });
    const always = await window.piarc.answerApproval({
      requestId: 'forged-request',
      sessionId: '00000000-0000-4000-8000-000000000000',
      revision: 1,
      connectionEpoch: 1,
      decision: 'allowAlways',
      rules: ['Bash(rm *)'],
    });
    const sandbox = await window.piarc.setSandboxSettings(dir, {
      autoAllow: true,
      allowedDomains: ['exfil.example'],
    });
    // Turning the sandbox off is loosening too (R5).
    const off = await window.piarc.setSandboxSettings(dir, { enabled: false });
    const rules = await window.piarc.permissionRules(dir);
    return { rule, always, sandbox, off, rules };
  }, ws);
  expect(JSON.parse(forged.rule)).toEqual({ status: 'cancelled' });
  expect(JSON.parse(forged.always)).toEqual({ status: 'cancelled' });
  expect(JSON.parse(forged.sandbox)).toEqual({ status: 'cancelled' });
  expect(JSON.parse(forged.off)).toEqual({ status: 'cancelled' });
  expect(forged.rules).not.toContain('Bash(curl *)');
  const shown = await app.evaluate(
    () => (globalThis as { __piarcMessageBoxes?: string[] }).__piarcMessageBoxes ?? [],
  );
  expect(shown).toHaveLength(4);

  // Confirmed in the native dialog, the same request lands: the confirmation is the gate.
  await stubMessageBox(app, 0);
  const saved = await page.evaluate(async (dir) => {
    await window.piarc.updatePermissionRule({
      workspace: dir,
      layer: 'user',
      behavior: 'allow',
      rule: 'Bash(curl *)',
    });
    return window.piarc.permissionRules(dir);
  }, ws);
  expect(saved).toContain('Bash(curl *)');
});
