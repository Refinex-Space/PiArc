// T22: the user-level memory file preference survives closing the settings window.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from './fixtures.js';
import { test as sessionTest } from './sessions.js';
import { idle, openSession, requests } from './t19.js';

test('both memory files can be enabled and disabled from General settings', async ({
  app,
  page,
  userDataDir,
}, testInfo) => {
  async function openGeneral() {
    const opened = app.waitForEvent('window');
    await page.getByTestId('open-settings').click();
    const settings = await opened;
    await settings.getByTestId('settings-page-general').waitFor();
    return settings;
  }
  const settings = await openGeneral();
  await settings.getByTestId('setting-language').selectOption('en');
  const choice = settings.getByRole('checkbox', { name: /Read both CLAUDE\.md and AGENTS\.md/ });
  await expect(choice).not.toBeChecked();
  // Controlled inputs reflect Core's acknowledged write, which crosses IPC after the click.
  await choice.click();
  await expect(choice).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.piarc.getAppState()).preferences.memory.readBoth),
    )
    .toBe(true);
  await settings.close();

  const reopened = await openGeneral();
  await reopened.getByTestId('setting-language').selectOption('zh-CN');
  const restored = reopened.getByRole('checkbox', {
    name: /当 CLAUDE\.md 与 AGENTS\.md 位于同一目录时/,
  });
  await expect(restored).toBeChecked();
  await reopened.screenshot({ path: testInfo.outputPath('memory-read-both.png') });
  await restored.click();
  await expect(restored).not.toBeChecked();
  const saved = () => readFile(path.join(userDataDir, 'settings.json'), 'utf8');
  await expect
    .poll(async () => JSON.parse(await saved()) as unknown)
    .toMatchObject({
      memory: { readBoth: false },
      language: 'zh-CN',
    });
});

sessionTest(
  'the first turn waits for the external memory card and continues after a decline',
  async ({ app, page, workspaces, mock }, info) => {
    const name = 'external-notes.md';
    const marker = 'test-only external instruction';
    await writeFile(path.join(workspaces, name), marker);
    await openSession(
      app,
      page,
      workspaces,
      'memory review',
      't18-chat',
      'Read the project instructions.',
      {
        'CLAUDE.md': `Project instructions.\n@../${name}\n`,
      },
    );
    const card = page.getByTestId('approval-card');
    await expect(card).toHaveAttribute('data-approval-card', 'permissionExpansion');
    await expect(card).toContainText('MemoryImport');
    await expect(card).toContainText(name);
    expect(await requests(mock, 't18-chat')).toHaveLength(0);
    await card.screenshot({ path: info.outputPath('external-memory-approval.png') });
    await card.getByRole('button', { name: 'Decline' }).click();
    await expect(page.getByText('Done.', { exact: true })).toBeVisible();
    await idle(page);
    const sent = await requests(mock, 't18-chat');
    expect(sent).toHaveLength(1);
    const system = JSON.stringify(sent[0]?.body.system);
    expect(system).toContain('Memory import denied');
    expect(system).not.toContain(marker);
    await page.screenshot({ path: info.outputPath('external-memory-declined.png') });
  },
);
