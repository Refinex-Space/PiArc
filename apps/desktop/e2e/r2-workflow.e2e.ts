// The same fixture and approvals are used on macOS and Windows (W1).
import { closeSettings } from './settings-panel.js';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle } from './t19.js';
import { addEndpoint, settingsWindow } from './provider-settings.js';

test.use({ seedMockModel: false });

const files = {
  'sum.cjs': 'exports.sum = (a, b) => a - b;\n',
  'sum.test.cjs':
    "const { test } = require('node:test');\nconst { strict: assert } = require('node:assert');\nconst { sum } = require('./sum.cjs');\ntest('sum adds two numbers', () => assert.equal(sum(3, 2), 5));\n",
};
const command = 'node --test sum.test.cjs';
const task =
  'Read sum.cjs and sum.test.cjs to diagnose the failing test. Fix sum.cjs with Edit, then use Bash to run node --test sum.test.cjs. Keep the test unchanged.';

for (const [id, api, format] of [
  ['messages', 'anthropic-messages', 'anthropic_messages'],
  ['chat', 'openai-completions', 'openai_chat_completions'],
] as const) {
  test(`R2 completes a failing project through ${api}`, async ({
    app,
    page,
    mock,
    workspaces,
  }, info) => {
    test.setTimeout(120_000);
    const settings = await settingsWindow(page);
    await addEndpoint(
      settings,
      id,
      id === 'chat' ? mock.baseUrl + '/v1' : mock.baseUrl,
      api,
      'fixture',
    );
    await settings.screenshot({ path: info.outputPath('settings.png') });
    await closeSettings(settings);
    const ws = await makeWorkspace(workspaces, '加法 regression', files);
    const init = spawnSync('git', ['init', '--quiet'], { cwd: ws, encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
    const run = () =>
      spawnSync(process.execPath, ['--test', 'sum.test.cjs'], { cwd: ws, encoding: 'utf8' });
    const before = run();
    expect(before.status).toBe(1);
    expect(before.stdout).toContain('ERR_ASSERTION');
    await writeFile(info.outputPath('before.txt'), before.stdout);
    await openFolder(page, app, ws);
    await page.getByTestId('home-model').selectOption(id + '/fixture');
    await startSession(page, task, 'r2-workflow');
    await expect(page.getByTestId('permission-mode')).toContainText('Manual');
    const card = page.getByTestId('approval-card');
    for (const [kind, content] of [
      ['fileChange', 'sum.cjs'],
      ['command', command],
    ] as const) {
      await expect(card).toHaveAttribute('data-approval-card', kind);
      await expect(card).toContainText(content);
      await card.screenshot({ path: info.outputPath(kind + '.png') });
      await card.getByRole('button', { name: 'Allow once', exact: true }).click();
    }
    // The approved Bash runs a real `node --test`; through Git Bash on a Windows runner it took
    // more than the default 5 s (CI run 44453549786).
    await expect(
      page.getByTestId('agent-message').filter({ hasText: 'The sum test passed.' }),
    ).toBeVisible({ timeout: 60_000 });
    await idle(page);
    await page.screenshot({ path: info.outputPath('completed.png') });
    const records = (await (await fetch(mock.baseUrl + '/_piarc/requests')).json()) as {
      format: string;
      scenario: string;
      body: string;
      violations: unknown[];
    }[];
    const turns = records.filter((r) => r.scenario === 'r2-workflow');
    expect(turns.map((r) => [r.format, r.violations])).toEqual(
      Array.from({ length: 4 }, () => [format, []]),
    );
    expect(turns[1]?.body).toContain('a - b');
    expect(turns[1]?.body).toContain('assert.equal(sum(3, 2), 5)');
    expect(turns.at(-1)?.body).toMatch(/(?:pass 1|tests? passed)/iu);
    expect(await readFile(path.join(ws, 'sum.test.cjs'), 'utf8')).toBe(files['sum.test.cjs']);
    const after = run();
    expect(after.status).toBe(0);
    await writeFile(info.outputPath('after.txt'), after.stdout);
  });
}
