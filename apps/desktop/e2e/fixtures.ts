// Playwright fixtures for L4 tests: every test gets a freshly launched app with its own
// user-data directory (system temp dir, path with a space and Chinese characters), its first
// window, and the app's stdout/stderr. The log is saved next to the test's other evidence.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  _electron as electron,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

import { appCommand, type AppForm } from './app.js';

/** Lines the app wrote to stdout and stderr. */
export interface AppLog {
  text(): string;
  /** Resolves once a line matches `pattern`; rejects after `timeoutMs`. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<void>;
}

export interface Fixtures {
  userDataDir: string;
  /** Extra command-line arguments for the app, set per test file with `test.use`. */
  appArgs: string[];
  running: { app: ElectronApplication; log: AppLog };
  app: ElectronApplication;
  appLog: AppLog;
  page: Page;
}

export interface WorkerFixtures {
  appForm: AppForm;
}

function createLog(app: ElectronApplication): AppLog {
  let buffer = '';
  const waiters = new Set<() => void>();
  const append = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    for (const wake of waiters) {
      wake();
    }
  };
  const child = app.process();
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return {
    text: () => buffer,
    waitFor: (pattern, timeoutMs = 10_000) =>
      new Promise<void>((resolve, reject) => {
        const check = (): void => {
          if (pattern.test(buffer)) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(`App log did not match ${String(pattern)} within ${String(timeoutMs)} ms`),
          );
        }, timeoutMs);
        waiters.add(check);
        check();
      }),
  };
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  appForm: ['dev', { option: true, scope: 'worker' }],
  appArgs: [[], { option: true }],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here.
  userDataDir: async ({}, use) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc e2e 测试-'));
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
  running: async ({ appForm, appArgs, userDataDir }, use, testInfo) => {
    const { command, args } = appCommand(appForm, [`--user-data-dir=${userDataDir}`, ...appArgs]);
    const app = await electron.launch({ executablePath: command, args });
    const log = createLog(app);
    await use({ app, log });
    await app.close();
    await writeFile(testInfo.outputPath('app.log'), log.text(), 'utf8');
  },
  app: async ({ running }, use) => {
    await use(running.app);
  },
  appLog: async ({ running }, use) => {
    await use(running.log);
  },
  page: async ({ running }, use) => {
    const page = await running.app.firstWindow();
    await page.getByTestId('app-shell').waitFor();
    await use(page);
  },
});

export { expect } from '@playwright/test';
