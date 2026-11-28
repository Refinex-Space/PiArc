// Helpers for the T19 flows: a session with the real Core, Agent Host and mock provider behind
// the window, the composer driven by the keyboard, the mock's recorded requests, screenshots in
// both themes, and killing the Agent Host (an interruption Core recovers from).
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ElectronApplication, Page, TestInfo } from '@playwright/test';

import type { PreferenceChange } from '../src/shared/preferences.js';
import type { MockProcess } from './agent-host.js';
import { expect, focusMain, makeWorkspace, openFolder, startSession } from './sessions.js';

export async function prefer(page: Page, change: PreferenceChange): Promise<void> {
  await page.evaluate((c) => window.piarc.setPreference(c), change);
}

/**
 * Pi's settings for compaction tests: keep almost nothing, so `/compact` has work. `retryDelayMs`
 * is the backoff before an automatic retry (long enough to see the retry on screen).
 */
export async function seedCompaction(dataDir: string, retryDelayMs = 5): Promise<void> {
  await writeFile(
    path.join(dataDir, 'pi', 'settings.json'),
    JSON.stringify({
      retry: { baseDelayMs: retryDelayMs },
      compaction: { keepRecentTokens: 1 },
    }),
  );
}

/**
 * Opens a workspace with `files` and starts a session whose first message selects `scenario`;
 * returns the session id with the conversation in front, in English.
 */
export async function openSession(
  app: ElectronApplication,
  page: Page,
  workspaces: string,
  name: string,
  scenario: string,
  text: string,
  files: Record<string, string> = {},
): Promise<{ id: string; ws: string }> {
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, name, files);
  await openFolder(page, app, ws);
  const id = await startSession(page, text, scenario);
  await focusMain(app);
  return { id, ws };
}

/** Types into the composer (focusing it first). */
export async function typeInComposer(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer-input').click();
  await page.keyboard.type(text);
}

/** Sends `text` from the composer with Enter. */
export async function send(page: Page, text: string): Promise<void> {
  await typeInComposer(page, text);
  await page.keyboard.press('Enter');
}

/** Opens every folded tool group: a finished turn's calls fold into their summary (ADR-0079). */
export async function openToolGroups(page: Page): Promise<void> {
  for (const toggle of await page.getByTestId('tool-group-toggle').all()) {
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  }
}

/** Waits for the session's running turn to end (the working row goes away). */
export async function idle(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId('working-row')).toHaveCount(0, { timeout });
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'false');
}

export interface MockRequest {
  readonly scenario: string | undefined;
  readonly body: Record<string, unknown>;
}

/** The requests the mock received for `scenario`, in order, with their bodies. */
export async function requests(mock: MockProcess, scenario: string): Promise<MockRequest[]> {
  const response = await fetch(`${mock.baseUrl}/_piarc/requests`);
  const records = (await response.json()) as { scenario?: string; body?: string }[];
  return records
    .filter((record) => record.scenario === scenario)
    .map((record) => ({
      scenario: record.scenario,
      body: JSON.parse(record.body ?? '{}') as Record<string, unknown>,
    }));
}

/** The content blocks of the last user message of a request. */
export function lastUserBlocks(body: Record<string, unknown>): Record<string, unknown>[] {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[];
  const last = [...messages].reverse().find((message) => message.role === 'user');
  if (last === undefined) {
    return [];
  }
  return typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]
    : (last.content as Record<string, unknown>[]);
}

/** The actual wire roles, including consecutive user blocks from Pi (ADR-0026, I67). */
export function roles(request: MockRequest | undefined): string[] {
  const messages = request?.body.messages;
  if (!Array.isArray(messages)) throw new Error('Missing messages in the mock request');
  return messages.map((message: { role: string }) => message.role);
}

/** Every text of every user message of a request. */
export function userTexts(body: Record<string, unknown>): string[] {
  const messages = (body.messages ?? []) as { role: string; content: unknown }[];
  return messages
    .filter((message) => message.role === 'user')
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : (message.content as { type: string; text?: string }[])
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? ''),
    );
}

/** Screenshots of the main window in the light and the dark theme. */
export async function screenshots(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', theme);
    await page.screenshot({ path: testInfo.outputPath(`${name}-${theme}.png`) });
  }
  await prefer(page, { key: 'appearance.theme', value: 'system' });
}

/** Ends the test window's one direct Agent Host child. Core observes its exit and restarts it. */
export async function killAgentHost(app: ElectronApplication): Promise<void> {
  const parent = await app.evaluate(() => process.pid);
  const ids =
    process.platform === 'win32'
      ? execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${String(parent)} AND Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*agent-host.mjs*' }).ProcessId`,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        )
          .trim()
          .split(/\s+/u)
          .filter(Boolean)
      : execFileSync('ps', ['-axo', 'ppid=,pid=,command='], { encoding: 'utf8' })
          .split('\n')
          .flatMap((line) => {
            const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
            return Number(match?.[1]) === parent && match?.[3]?.includes('agent-host.mjs')
              ? [match[2]]
              : [];
          });
  const [pid] = ids.map(Number);
  if (ids.length !== 1 || !pid) throw new Error('Expected one Agent Host child of the test app');
  process.kill(pid, 'SIGKILL');
}
