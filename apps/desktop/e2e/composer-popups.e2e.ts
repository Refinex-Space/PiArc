// The composer's popups share the app's look on every platform: thumb-only scrollbars, a
// pointer over their rows, descriptions in a tooltip outside the list's right edge, and `/`
// palette groups that read as groups (a sticky heading, a hairline between them).
// Screenshots go to tmp/evidence/<task>/ with PIARC_EVIDENCE_TASK set.
import type { Locator, Page } from '@playwright/test';

import { expect, makeWorkspace, openFolder, test } from './sessions.js';
import { idle, openSession, typeInComposer } from './t19.js';

const SKILLS = Object.fromEntries(
  Array.from({ length: 14 }, (_, i) => {
    const name = `skill-${String(i + 1).padStart(2, '0')}`;
    return [
      `.claude/skills/${name}/SKILL.md`,
      `---\ndescription: Does task number ${String(i + 1)} with a description long enough to need a tooltip to read it all\n---\nDo it.\n`,
    ];
  }),
);
const FILES = {
  ...SKILLS,
  '.piarc/commands/release.md': '---\ndescription: Cut a release\n---\nRelease the build.\n',
  ...Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`docs/note-${String(i)}.md`, `Note ${String(i)}`]),
  ),
};

/** The shown tooltip sits outside `list`'s right edge, level with `row`. */
async function expectTooltipBeside(page: Page, list: Locator, row: Locator): Promise<void> {
  const tip = page.locator('.tooltip[data-placed="true"]');
  await expect(tip).toBeVisible();
  const [t, l, r] = await Promise.all([tip.boundingBox(), list.boundingBox(), row.boundingBox()]);
  if (!t || !l || !r) throw new Error('not laid out');
  expect(t.x).toBeGreaterThanOrEqual(l.x + l.width);
  expect(t.y).toBeLessThan(r.y + r.height);
  expect(t.y + t.height).toBeGreaterThan(r.y);
}

test('the / palette: sticky group headings, pointer rows, descriptions beside the list', async ({
  app,
  page,
  workspaces,
}, info) => {
  await openSession(app, page, workspaces, 'popups', 't37-chat#palette', 'Hello', FILES);
  await idle(page);
  await typeInComposer(page, '/');
  const popup = page.getByTestId('command-popup');
  await expect(popup).toBeVisible();
  const option = popup.locator('[data-command="skill-02"]');
  await expect(option).toHaveCSS('cursor', 'pointer');
  // Neighbouring rows keep a gap, so a hovered row never merges with the selected one.
  const gap = await popup.evaluate((el) => {
    const rows = [...el.querySelectorAll('[role="option"]')].map((r) => r.getBoundingClientRect());
    return Math.min(...rows.slice(1).map((r, i) => r.top - (rows[i]?.bottom ?? 0)));
  });
  expect(gap).toBeGreaterThanOrEqual(2);
  // Hovering scrolls the row into view first; that scroll closes any bubble, and the next
  // move over the row opens it.
  await option.hover();
  const box = await option.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height / 2);
  await expectTooltipBeside(page, popup, option);
  await page.screenshot({ path: info.outputPath('palette-tooltip.png') });

  // A later group starts with a hairline; scrolled into it, its heading stays at the top.
  await expect(popup.locator('.command-section').nth(1)).toHaveCSS('border-top-style', 'solid');
  await popup.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const stuck = await popup.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    return [...el.querySelectorAll('[data-testid="command-group"]')].some(
      (g) => Math.abs(g.getBoundingClientRect().top - top) <= 2,
    );
  });
  expect(stuck).toBe(true);
  // The stuck heading covers the list's top edge: nothing scrolled shows above it.
  const covered = await popup.evaluate((el) => {
    const label = [...el.querySelectorAll('.command-group-label')].at(-1);
    return (label?.getBoundingClientRect().top ?? Infinity) - el.getBoundingClientRect().top;
  });
  expect(covered).toBeLessThanOrEqual(0.5);
  // Stuck, the heading ends in a hairline.
  await expect(
    popup.locator('.command-section').last().locator('.command-group-label'),
  ).not.toHaveCSS('border-bottom-color', 'rgba(0, 0, 0, 0)');
  await page.mouse.move(0, 0);
  await popup.hover();
  await page.screenshot({ path: info.outputPath('palette-scrolled.png') });
  await page.keyboard.press('Escape');

  // The @ list: pointer rows, the same scrollbar.
  await typeInComposer(page, '@note');
  const mentions = page.getByTestId('mention-popup');
  await expect(mentions.getByRole('option').first()).toBeVisible();
  await expect(mentions.getByRole('option').first()).toHaveCSS('cursor', 'pointer');
  await expect(mentions).toHaveCSS('row-gap', '2px');
  await mentions.hover();
  await page.screenshot({ path: info.outputPath('mention-popup.png') });
});

test('the + menu’s skills: pointer rows and each description beside the submenu', async ({
  app,
  page,
  workspaces,
}, info) => {
  const ws = await makeWorkspace(workspaces, 'plus menu', FILES);
  await openFolder(page, app, ws);
  await page.getByTestId('composer-add').click();
  const skills = page.getByRole('menuitem', { name: 'Skills' });
  await skills.hover();
  const submenu = page.locator('.menu').last();
  const row = submenu.getByRole('menuitem', { name: 'skill-03' });
  await expect(row).toBeVisible();
  await expect(row).toHaveCSS('cursor', 'pointer');
  await expect(row).not.toHaveAttribute('title');
  await row.hover();
  await expectTooltipBeside(page, submenu, row);
  await page.screenshot({ path: info.outputPath('plus-skills.png') });
});
