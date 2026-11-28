// Settings › Agents › Instructions (ADR-0108): Pi's global AGENTS.md in the test home's
// `~/.pi/agent` (L4 never reads the real home). The page creates the file, refuses to overwrite an
// edit made on disk and loads it again, and the next session's system prompt carries the text.
// Screenshots go to tmp/evidence/<task>/ with PIARC_EVIDENCE_TASK set.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { closeSettings, openSettings } from './settings-panel.js';
import { expect, test } from './sessions.js';
import { idle, openSession, prefer, requests } from './t19.js';

test('Pi’s global instructions are edited in settings and reach the next session', async ({
  app,
  page,
  mock,
  workspaces,
  userDataDir,
}, testInfo) => {
  test.setTimeout(120_000);
  const file = path.join(userDataDir, 'test-home', '.pi', 'agent', 'AGENTS.md');
  await prefer(page, { key: 'language', value: 'en' });
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-instructions').click();
  await expect(settings.getByTestId('settings-page-instructions')).toBeVisible();
  const where = settings.getByTestId('instructions-path');
  await expect(where).toContainText(path.join('.pi', 'agent', 'AGENTS.md'));
  await expect(where).toContainText('created when you save');
  const editor = settings.getByTestId('instructions-editor');
  const save = settings.getByTestId('instructions-save');
  await expect(save).toBeDisabled();

  const marker = 'Answer in haiku when asked about the weather.';
  await editor.fill(`# Global\n${marker}\n`);
  await save.click();
  await expect(settings.getByText('Saved. New turns use it.')).toBeVisible();
  await expect(where).not.toContainText('created when you save');
  expect(await readFile(file, 'utf8')).toBe(`# Global\n${marker}\n`);
  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await settings.screenshot({ path: testInfo.outputPath(`instructions-${theme}.png`) });
  }
  await prefer(page, { key: 'appearance.theme', value: 'light' });

  // Pi's CLI (or an editor) changes the file while the page shows the old text.
  await writeFile(file, `# Global\n${marker}\nEdited in Pi.\n`);
  await editor.fill(`# Global\n${marker}\nMine.\n`);
  await save.click();
  await expect(settings.getByTestId('instructions-error')).toContainText('changed on disk');
  await settings.screenshot({ path: testInfo.outputPath('instructions-conflict.png') });
  expect(await readFile(file, 'utf8')).toContain('Edited in Pi.');
  await settings.getByTestId('instructions-reload').click();
  await expect(editor).toHaveValue(`# Global\n${marker}\nEdited in Pi.\n`);
  await expect(settings.getByTestId('instructions-error')).toHaveCount(0);
  await closeSettings(settings);

  await openSession(app, page, workspaces, 'pi instructions', 't18-chat', 'Hello.');
  await expect(page.getByText('Done.', { exact: true })).toBeVisible();
  await idle(page);
  const sent = await requests(mock, 't18-chat');
  expect(sent).toHaveLength(1);
  const system = JSON.stringify(sent[0]?.body.system);
  expect(system).toContain(marker);
  expect(system).toContain('Edited in Pi.');
});
