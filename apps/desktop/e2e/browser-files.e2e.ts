// The agent's files in the built-in browser (design addendum B2.6.6, THR-16): a download the
// agent's `Browser` script saves goes through Core's write decision (a card in manual mode),
// lands in the workspace and keeps the mark of a file from the internet. The mock's script
// needs the workspace path, so this file writes its own scenario before the mock starts.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startMock } from './agent-host.js';
import { expect, test as base } from './sessions.js';
import { idle, openSession } from './t19.js';

function saveScript(target: string): string {
  return [
    'const task = await taskSpace("files");',
    'const page = task.page("p1");',
    'const pending = page.waitForEvent("download");',
    'await page.evaluate(() => {',
    '  const a = document.createElement("a");',
    '  a.href = URL.createObjectURL(new Blob(["a,b\\n1,2\\n"], { type: "text/csv" }));',
    '  a.download = "report.csv";',
    '  document.body.append(a);',
    '  a.click();',
    '});',
    'const download = await pending;',
    'console.log("downloaded", download.suggestedFilename());',
    `await download.saveAs(${JSON.stringify(target)});`,
    'console.log("saved");',
    'await task.finish({ keep: [] });',
  ].join('\n');
}

const test = base.extend<{ fileRoot: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here.
  fileRoot: async ({}, use) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc browser 文件-')));
    await use(root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  },
  mock: async ({ fileRoot }, use) => {
    const scenarios = path.join(fileRoot, 'scenarios');
    await mkdir(scenarios, { recursive: true });
    const target = path.join(fileRoot, 'work', 'Agent files', 'saved', 'report.csv');
    await writeFile(
      path.join(scenarios, 'browser-files.json'),
      JSON.stringify({
        id: 'browser-files',
        steps: [
          {
            tool_calls: [
              {
                id: 'browser1',
                name: 'Browser',
                input: { description: 'Save the report', script: saveScript(target) },
              },
            ],
          },
          { text: 'The report is saved.' },
        ],
      }),
    );
    const mock = await startMock(scenarios);
    await use(mock);
    mock.stop();
  },
});

test('B2.6.6 a download the agent saves asks first and lands in the workspace, quarantined', async ({
  app,
  page,
  fileRoot,
}) => {
  test.setTimeout(150_000);
  const base = path.join(fileRoot, 'work');
  const { ws } = await openSession(app, page, base, 'Agent files', 'browser-files', 'Save it');
  const card = page.getByTestId('approval-card');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('save this download');
  await expect(card).toContainText(/saved[\\/]report\.csv/u);
  await card.getByRole('button', { name: 'Allow once', exact: true }).click();
  await idle(page);
  await expect(page.getByTestId('agent-message').getByText('The report is saved.')).toBeVisible();
  await expect(page.getByTestId('browser-card')).toHaveAttribute('data-status', 'completed');
  const saved = path.join(ws, 'saved', 'report.csv');
  expect(await readFile(saved, 'utf8')).toBe('a,b\n1,2\n');
  if (process.platform === 'darwin') {
    const mark = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', saved], {
      encoding: 'utf8',
    });
    expect(mark).toMatch(/^0081;[0-9a-f]+;PiArc;/u);
  }
});
