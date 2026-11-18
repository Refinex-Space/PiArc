// T19-A10: the existing inert-rendering corpus travels through a real session and tool I/O.
// The command only reads a fixture; markup in file names is tested on a missing edit target
// so that platforms with different path rules can display the same attempted path.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { XSS_PAYLOADS, xssMessage } from '../src/shared/xss-payloads.js';
import { startMock } from './agent-host.js';
import { expect, test as base } from './sessions.js';
import { idle, openSession, send } from './t19.js';
import { expectInert, expectInertDom, inspect, watchMarkup } from './transcript.js';

const scenario = 't19-inert';
const filename = 'samples.txt';
// The same corpus as the Markdown tests, one sample per line so it fits a Read preview.
const samples = XSS_PAYLOADS.map((sample) => sample.markdown).join('\n');
const pathSample = XSS_PAYLOADS.find((sample) => sample.id === 'img-onerror');
if (pathSample === undefined) throw new Error('Missing T09 path fixture');
const missingPath = `missing/${pathSample.markdown}`;

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern.
  mock: async ({}, use) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-t19-markup-'));
    try {
      const file = path.join(dir, 'scenario.json');
      await writeFile(
        file,
        JSON.stringify({
          id: scenario,
          steps: [
            { tool_calls: [{ id: 'toolu_read', name: 'Read', input: { path: filename } }] },
            { text: 'Read finished.' },
            {
              tool_calls: [
                { id: 'toolu_bash', name: 'Bash', input: { command: 'cat samples.txt' } },
              ],
            },
            { text: 'Command finished.' },
            {
              tool_calls: [
                {
                  id: 'toolu_edit',
                  name: 'Edit',
                  input: { path: missingPath, edits: [{ oldText: 'old', newText: 'new' }] },
                },
              ],
            },
            { text: 'The target was missing.' },
            { text: xssMessage() },
          ],
        }),
      );
      const mock = await startMock(file);
      try {
        await use(mock);
      } finally {
        mock.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});

test('renders reply, tool output, command output and file paths as inert text', async ({
  app,
  page,
  workspaces,
}, info) => {
  await watchMarkup(page);
  await openSession(app, page, workspaces, 'markup', scenario, 'Read the sample file.', {
    [filename]: samples,
  });
  await expect(page.getByTestId('agent-message').last()).toContainText('Read finished.');
  await idle(page);
  const read = page.getByTestId('tool-group').filter({ hasText: 'Read samples.txt' });
  await read.getByTestId('tool-group-toggle').click();
  const call = read.getByTestId('tool-call');
  await call.getByRole('button').click();
  for (const sample of XSS_PAYLOADS) {
    await expect(call.locator('.tool-output')).toContainText(sample.markdown);
  }
  expectInertDom(await inspect(page));
  await read.getByTestId('tool-group-toggle').click();

  await send(page, 'Print the same file.');
  await expect(page.getByTestId('agent-message').last()).toContainText('Command finished.');
  await idle(page);
  const bash = page.getByTestId('bash-card');
  await expect(bash).toHaveAttribute('data-outcome', 'success');
  await bash.getByTestId('bash-output-toggle').click();
  for (const sample of XSS_PAYLOADS) {
    await expect(bash.getByTestId('bash-output')).toContainText(sample.markdown);
  }
  expectInertDom(await inspect(page));
  await bash.getByTestId('bash-output-toggle').click();

  await send(page, 'Try editing the missing target.');
  await expect(page.getByTestId('agent-message').last()).toContainText('The target was missing.');
  await idle(page);
  await page
    .getByTestId('tool-group')
    .filter({ hasText: 'Edited' })
    .getByTestId('tool-group-toggle')
    .click();
  await expect(page.getByTestId('file-change-path')).toHaveText(missingPath);
  expectInertDom(await inspect(page));

  await send(page, 'Show the samples in the reply.');
  const reply = page.getByTestId('agent-message').last();
  for (const sample of XSS_PAYLOADS) {
    await expect(reply).toContainText(sample.visibleText);
  }
  await expect(reply).toHaveAttribute('data-parsed', 'final');
  expectInert(await inspect(page));
  await page.screenshot({ path: info.outputPath('inert-reply.png') });
});
