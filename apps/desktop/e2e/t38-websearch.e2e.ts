// T38-A03 and A05 with the real Core, Agent Host and mock provider. A05: a WebSearch answered by
// the provider's own search (the per-model setting turns it on for the mock model) shows its
// sources in the transcript, and a click opens one only after the main process's confirmation
// (the dialog and shell.openExternal are recording doubles). A03: with no native search and no
// search service the session's request lacks WebSearch and the settings page says why; saving
// a key for the chosen service makes it available. Screenshots go to tmp/evidence/T38/.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { settingsWindow } from './provider-settings.js';
import { expect, test } from './sessions.js';
import { idle, openSession, requests } from './t19.js';

const EVIDENCE = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tmp',
  'evidence',
  process.env.PIARC_EVIDENCE_TASK ?? 'L4',
);

async function shoot(page: Page, name: string, testId?: string): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  const target = testId === undefined ? page : page.getByTestId(testId);
  await target.screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
}

/** Merges `value` into the user's settings file before the app reads it. */
async function userSettings(dataDir: string, value: Record<string, unknown>): Promise<void> {
  const file = path.join(dataDir, 'settings.json');
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // No file yet.
  }
  await writeFile(file, JSON.stringify({ ...current, ...value }));
}

interface Recorder {
  __t38Links?: string[];
}

/** The link confirmation answers `response`; openExternal only records. */
async function recordLinks(app: ElectronApplication, response: 0 | 1): Promise<void> {
  await app.evaluate(({ dialog, shell }, answer) => {
    const calls: string[] = [];
    (globalThis as Recorder).__t38Links = calls;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as { detail?: unknown };
      calls.push(`confirm ${typeof options.detail === 'string' ? options.detail : ''}`);
      return Promise.resolve({ response: answer, checkboxChecked: false });
    };
    shell.openExternal = (url: string) => {
      calls.push(`open ${url}`);
      return Promise.resolve();
    };
  }, response);
}

async function links(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as Recorder).__t38Links ?? []);
}

/** The mock model selects `scenario` by header: the native search's auxiliary request carries
 * no scenario marker. */
async function selectByHeader(dataDir: string, scenario: string): Promise<void> {
  const file = path.join(dataDir, 'pi', 'models.json');
  const models = JSON.parse(await readFile(file, 'utf8')) as {
    providers: Record<string, { models: Record<string, unknown>[] }>;
  };
  for (const provider of Object.values(models.providers)) {
    for (const model of provider.models) model.headers = { 'x-piarc-scenario': scenario };
  }
  await writeFile(file, JSON.stringify(models));
}

test.describe('native search', () => {
  test.beforeEach(async ({ userDataDir }) => {
    await selectByHeader(userDataDir, 't38-search');
    await userSettings(userDataDir, {
      modelProviders: { models: { 'piarc-mock/mock-large': { nativeWebSearch: true } } },
      permissions: { allow: ['WebSearch'] },
    });
  });

  test('search results show their sources and open only after confirmation', async ({
    app,
    page,
    workspaces,
    mock,
  }) => {
    await openSession(app, page, workspaces, 'search', 't38-search', 'What is new in PiArc?');
    await idle(page);
    const card = page.getByTestId('web-search-card');
    await expect(card).toHaveAttribute('data-status', 'completed');
    await expect(card.getByTestId('web-search-query')).toHaveText('piarc release');
    const sources = card.getByTestId('web-search-source');
    await expect(sources).toHaveCount(2);
    await expect(sources.first()).toContainText('PiArc 1.0 released');
    await expect(sources.first()).toContainText('piarc.example');
    await shoot(page, 'websearch-sources', 'conversation');

    // The auxiliary request carried only the provider's search tool.
    const sent = await requests(mock, 't38-search');
    expect(sent).toHaveLength(3);
    expect(JSON.stringify(sent[1]?.body.tools)).toContain('web_search_20250305');

    await recordLinks(app, 1);
    await sources.first().getByRole('link').click();
    await expect.poll(() => links(app)).toEqual(['confirm https://piarc.example/blog/1-0']);
    await recordLinks(app, 0);
    await sources.nth(1).getByRole('link').click();
    await expect
      .poll(() => links(app))
      .toEqual([
        'confirm https://docs.piarc.example/changelog',
        'open https://docs.piarc.example/changelog',
      ]);
  });
});

test('without a backend WebSearch is not offered and the settings page says why', async ({
  app,
  page,
  workspaces,
  mock,
}) => {
  await openSession(app, page, workspaces, 'plain', 't38-plain', 'Search the web.');
  await idle(page);
  const sent = await requests(mock, 't38-plain');
  const tools = (sent[0]?.body.tools ?? []) as { name?: string }[];
  expect(tools.map((t) => t.name)).not.toContain('WebSearch');
  expect(tools.map((t) => t.name)).toContain('WebFetch');

  const settings = await settingsWindow(page);
  const section = settings.getByTestId('web-search-section');
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId('web-search-status')).toContainText('WebSearch is unavailable');
  await shoot(settings, 'websearch-settings-unavailable', 'web-search-section');

  await section.getByTestId('web-search-backend').selectOption('brave');
  await expect(section.getByTestId('web-search-status')).toContainText('needs an API key');
  await section.getByTestId('web-search-key').fill('l4-brave-key-5e1d');
  await section.getByTestId('web-search-key-save').click();
  await expect(section.getByTestId('web-search-status')).toContainText(
    'models without their own search use Brave Search',
  );
  await expect(section.getByTestId('web-search-key')).toHaveValue('');
  await expect(section.getByTestId('web-search-key-remove')).toBeVisible();
  await shoot(settings, 'websearch-settings-service', 'web-search-section');
});
