// The new session page's hero (shell/Mascot.tsx, shell/Home.tsx): the block mascot drops in and
// keeps moving (walks, hops, blinks: its frames switch), stands still in the middle under
// "reduce motion", and the line under it names the project and opens the project menu.
// Screenshots go to tmp/evidence/<task>/ with PIARC_EVIDENCE_TASK set.
import { expect, makeWorkspace, openFolder, test } from './sessions.js';
import { prefer } from './t19.js';

test('the mascot moves, holds still when motion is reduced, and the line picks the project', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  test.setTimeout(90_000);
  await prefer(page, { key: 'language', value: 'zh-CN' });
  const other = await makeWorkspace(workspaces, 'other project');
  await openFolder(page, app, other);
  await openFolder(page, app, await makeWorkspace(workspaces, 'mascot'));
  const mascot = page.getByTestId('home-mascot');
  await expect(mascot).toBeVisible();
  await expect(mascot).toHaveAttribute('aria-hidden', 'true');

  // Its frames change on their own: it drops in, waves and goes on.
  const poses = new Set<string>();
  const until = Date.now() + 6_000;
  while (Date.now() < until && poses.size < 4) {
    poses.add((await mascot.getAttribute('data-pose')) ?? '');
    await page.waitForTimeout(60);
  }
  expect(poses.size).toBeGreaterThanOrEqual(4);

  const line = page.getByTestId('home-greeting');
  await expect(line).toHaveText(/接下来，在\s*mascot\s*做点什么？/u);
  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath(`home-${theme}.png`) });
  }
  await prefer(page, { key: 'appearance.theme', value: 'light' });

  // The project in the line opens the project menu, searchable; picking one switches the page.
  await page.getByTestId('home-greeting-project').click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('home-project-menu.png') });
  await page.keyboard.type('other');
  await page.getByRole('menuitem', { name: 'other project' }).click();
  await expect(line).toHaveText(/other project/u);

  await prefer(page, { key: 'appearance.reduceMotion', value: 'on' });
  await expect(mascot).toHaveAttribute('data-pose', 'idle', { timeout: 3_000 });
  await page.waitForTimeout(2_500);
  await expect(mascot).toHaveAttribute('data-pose', 'idle');
  await prefer(page, { key: 'appearance.reduceMotion', value: 'system' });

  await prefer(page, { key: 'language', value: 'en' });
  await expect(line).toHaveText(/What’s next in\s*other project\s*\?/u);
});
