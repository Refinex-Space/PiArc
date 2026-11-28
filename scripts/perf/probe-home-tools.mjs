// The new-session view's first tool (ADR-0099): in a project opened just before, the click on
// the Files tool opens a draft session (Core opens the workspace's Agent Host session) and then
// the file tree. Each run opens a new project, clicks Files as soon as the view shows it, and
// takes two times from the click: until the tool's tile shows (the preparing tile, or the tree
// when the draft was faster) and until the file tree lists the project. Standalone: chapter 11
// has no row for it yet, so `run.mjs` does not gate it.
//
//   node scripts/perf/probe-home-tools.mjs --form packaged [--runs 5] [--settle 0] [--out <file.json>]
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain } from '../lib/repo.mjs';
import { launchApp, openWorkspace, seedModels, sleep, startMock, stats } from './lib.mjs';

/**
 * Times the first Files click in `runs` new projects of one app.
 * @param {{ form: 'packaged' | 'dev', runs: number, settle: number }} options
 */
export async function measure(options) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc perf 工具 ')));
  const userData = path.join(root, 'data');
  const scenarios = path.join(root, 'scenarios');
  await mkdir(scenarios, { recursive: true });
  const mock = await startMock(scenarios);
  await seedModels(userData, mock.baseUrl);
  const { app, page } = await launchApp(options.form, userData);
  /** @type {number[]} */
  const tile = [];
  /** @type {number[]} */
  const tree = [];
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 840);
    });
    for (let run = 0; run < options.runs; run++) {
      const workspace = path.join(root, `project ${String(run)} 项目`);
      await mkdir(path.join(workspace, 'src'), { recursive: true });
      await writeFile(path.join(workspace, 'README.md'), `# project ${String(run)}\n`);
      await writeFile(path.join(workspace, 'src', 'main.ts'), 'export {};\n');
      await openWorkspace(app, page, workspace);
      // The home view of the previous project is there already: wait for this one's.
      await page
        .getByTestId('home-workspace')
        .filter({ hasText: path.basename(workspace) })
        .waitFor();
      if (options.settle > 0) await sleep(options.settle);
      const clicked = Date.now();
      await page.getByTestId('tool-files').click();
      await page
        .locator('[data-testid="tool-preparing"], [role="treeitem"]')
        .first()
        .waitFor({ timeout: 60_000 });
      tile.push(Date.now() - clicked);
      await page
        .getByRole('treeitem', { name: 'README.md', exact: true })
        .waitFor({ timeout: 60_000 });
      tree.push(Date.now() - clicked);
      // Back to an empty home view: the next project starts without the tool open.
      await page.getByTestId('tool-files').click();
    }
  } finally {
    await app.close().catch(() => undefined);
    mock.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  return {
    values: { 'home-tool-tile': stats(tile).median, 'home-tool-content': stats(tree).median },
    samples: tree.length,
    detail: { tileMs: tile, treeMs: tree, settleMs: options.settle },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      form: { type: 'string', default: 'packaged' },
      runs: { type: 'string', default: '5' },
      settle: { type: 'string', default: '0' },
      out: { type: 'string' },
    },
  });
  const result = await measure({
    form: values.form === 'dev' ? 'dev' : 'packaged',
    runs: Math.max(1, Number.parseInt(values.runs, 10) || 5),
    settle: Math.max(0, Number.parseInt(values.settle, 10) || 0),
  });
  console.log(JSON.stringify(result, null, 2));
  if (values.out !== undefined) {
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
}

if (isMain(import.meta.url)) await main();
