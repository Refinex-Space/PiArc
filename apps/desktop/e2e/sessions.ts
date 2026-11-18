// Helpers for the T18 flows: a mock model the app's Agent Host talks to (Pi's `models.json`
// in the test's data directory), workspaces on disk, stubs for the native dialogs (Playwright
// cannot click them), and the steps of starting a session.
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

import { startMock, type MockProcess } from './agent-host.js';
import { appCommand } from './app.js';
import { expect, test as base } from './fixtures.js';
import type {} from '../src/shared/test-hooks.js';

const SCENARIOS = path.join(import.meta.dirname, 'scenarios');

export interface SessionFixtures {
  mock: MockProcess;
  /** A directory for workspaces (path with a space and Chinese characters). */
  workspaces: string;
}

/** Pi's model configuration pointing at the mock (the only model the Agent Host knows). */
export async function seedModels(dataDir: string, baseUrl: string): Promise<void> {
  await mkdir(path.join(dataDir, 'pi'), { recursive: true });
  const model = {
    id: 'mock-large',
    name: 'mock-large',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  await writeFile(
    path.join(dataDir, 'pi', 'models.json'),
    JSON.stringify({
      providers: {
        'piarc-mock': {
          baseUrl,
          api: 'anthropic-messages',
          apiKey: 'piarc-mock-test-key',
          models: [model],
        },
      },
    }),
  );
  // Retries wait milliseconds, not seconds.
  await writeFile(
    path.join(dataDir, 'pi', 'settings.json'),
    JSON.stringify({ retry: { baseDelayMs: 5 } }),
  );
}

export const test = base.extend<SessionFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here.
  mock: async ({}, use) => {
    const mock = await startMock(SCENARIOS);
    await use(mock);
    mock.stop();
  },
  userDataDir: async ({ userDataDir, mock }, use) => {
    await seedModels(userDataDir, mock.baseUrl);
    await use(userDataDir);
  },
  workspaces: async ({ app }, use) => {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc t18 工作区-')));
    await use(dir);
    // The app keeps the workspaces open (the Agent Host's working directory, Core's settings
    // watcher), and Windows cannot delete a directory in use: close it first. Closing twice is
    // harmless, so the app fixture's own close still works.
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  },
});

export { expect };

/** Creates a workspace directory with `files` (relative path → content). */
export async function makeWorkspace(
  root: string,
  name: string,
  files: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}

/** The next folder picker returns `dir`. */
export async function stubFolderDialog(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, dir);
}

/** Native message boxes answer with button `response` and record their message. */
export async function stubMessageBox(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, answer) => {
    const shown: string[] = [];
    (globalThis as { __piarcMessageBoxes?: string[] }).__piarcMessageBoxes = shown;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args[args.length - 1] as { message?: string };
      shown.push(options.message ?? '');
      return Promise.resolve({ response: answer, checkboxChecked: false });
    };
  }, response);
}

/** Opens `dir` as a workspace through the sidebar's folder button. */
export async function openFolder(page: Page, app: ElectronApplication, dir: string): Promise<void> {
  await stubFolderDialog(app, dir);
  await page.getByTestId('open-folder').click();
  await expect(page.getByTestId('home-workspace')).toHaveValue(dir);
}

/** Starts recording whether the optimistic message ever appeared. */
export async function watchOptimistic(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = { appeared: 0, text: '' };
    (globalThis as { __optimistic?: typeof seen }).__optimistic = seen;
    new MutationObserver(() => {
      const node = document.querySelector('[data-testid="optimistic-message"]');
      if (node !== null) {
        seen.appeared += 1;
        seen.text = node.textContent;
      }
    }).observe(document.body, { subtree: true, childList: true });
  });
}

export async function optimisticSeen(page: Page): Promise<{ appeared: number; text: string }> {
  return page.evaluate(
    () =>
      (globalThis as { __optimistic?: { appeared: number; text: string } }).__optimistic ?? {
        appeared: 0,
        text: '',
      },
  );
}

/**
 * Types `text` (with the mock's scenario marker) and starts the session. `trust` answers the
 * trust dialog when it appears (the first session of a workspace).
 */
export async function startSession(
  page: Page,
  text: string,
  scenario: string,
  trust: 'trust' | 'deny' | 'none' = 'trust',
): Promise<string> {
  const message = `${text} [[piarc-scenario:${scenario}]]`;
  await page.getByTestId('home-input').fill(message);
  await page.getByTestId('home-start').click();
  if (trust !== 'none') {
    await page.getByTestId(trust === 'trust' ? 'trust-accept' : 'trust-deny').click();
  }
  const conversation = page.getByTestId('conversation');
  await expect(conversation).toBeVisible({ timeout: 30_000 });
  const id = await conversation.getAttribute('data-session-id');
  if (id === null) {
    throw new Error('the conversation has no session id');
  }
  return id;
}

/** The session row of `id` in the sidebar. */
export function row(page: Page, id: string) {
  return page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);
}

/** Request bodies the mock received for `scenario`. */
export async function mockRequests(
  mock: MockProcess,
  scenario: string,
): Promise<{ tools: string[] }[]> {
  const response = await fetch(`${mock.baseUrl}/_piarc/requests`);
  const records = (await response.json()) as { scenario?: string; body?: string }[];
  return records
    .filter((record) => record.scenario === scenario)
    .map((record) => {
      const body = JSON.parse(record.body ?? '{}') as { tools?: { name?: string }[] };
      return { tools: (body.tools ?? []).map((tool) => tool.name ?? '') };
    });
}

/** Files under `dir` whose name contains `needle`. */
export async function filesNamed(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string) => {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.includes(needle)) {
        found.push(full);
      }
    }
  };
  await walk(dir);
  return found;
}

/**
 * Brings the app and its main window to the front (other apps may be active while tests run):
 * shown sessions are marked read only while their window is really in front.
 */
export async function focusMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    electronApp.focus({ steal: true });
    BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed() && !w.webContents.getURL().includes('#/settings'))
      ?.focus();
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (w) =>
            !w.isDestroyed() && w.isFocused() && !w.webContents.getURL().includes('#/settings'),
        ),
      ),
    )
    .toBe(true);
}

/** Launches the app again on the same data directory (a restart). */
export async function relaunch(
  form: 'dev' | 'packaged',
  userDataDir: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const { command, args } = appCommand(form, [`--user-data-dir=${userDataDir}`]);
  const app = await electron.launch({
    executablePath: command,
    args,
    env: { ...process.env, PIARC_TEST_MEMORY_KEYCHAIN: '1' },
  });
  const page = await app.firstWindow();
  await page.getByTestId('app-shell').waitFor();
  return { app, page };
}
