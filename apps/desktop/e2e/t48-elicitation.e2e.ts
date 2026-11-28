import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { test } from './sessions.js';
import { exerciseElicitation } from './elicitation.js';

test('MCP collects an editable form and opens a URL after a native confirmation', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120000);
  const evidence = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T48');
  await mkdir(evidence, { recursive: true });
  await exerciseElicitation(app, page, workspaces, async (state) => {
    await page.screenshot({ path: path.join(evidence, state.replace(':', '-') + '.png') });
  });
});
