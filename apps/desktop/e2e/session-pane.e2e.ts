// The session pane's states for visual review: every section of the session gallery
// (`#/session-gallery`, production rows in fixed states) in light and dark, both densities and
// both languages, plus a narrow window, reduced motion and forced colors. Screenshots go to
// tmp/evidence/<task>/gallery/<label>/ (label from PIARC_GALLERY_LABEL, default `current`);
// PIARC_GALLERY_SECTIONS (comma-separated) and PIARC_GALLERY_QUICK=1 (light and dark, comfortable,
// English) narrow a run while iterating. Each state is also checked for horizontal overflow.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { GALLERY_SECTIONS, SESSION_GALLERY_HASH } from '../src/shared/transcript-lab.js';
import type { PreferenceChange } from '../src/shared/preferences.js';
import { expect, test } from './fixtures.js';

const EVIDENCE = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tmp',
  'evidence',
  process.env.PIARC_EVIDENCE_TASK ?? 'L4',
  'gallery',
  process.env.PIARC_GALLERY_LABEL ?? 'current',
);

const SECTIONS: readonly string[] =
  process.env.PIARC_GALLERY_SECTIONS?.split(',').filter(Boolean) ?? GALLERY_SECTIONS;
const QUICK = process.env.PIARC_GALLERY_QUICK === '1';

async function prefer(page: Page, change: PreferenceChange): Promise<void> {
  await page.evaluate((c) => window.piarc.setPreference(c), change);
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows().find((w) => !w.webContents.isDestroyed());
      window?.setContentSize(size.width, size.height);
    },
    { width, height },
  );
}

async function open(page: Page, section: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
    window.location.reload();
  }, `${SESSION_GALLERY_HASH}?section=${section}`);
  await page.getByTestId('session-gallery').waitFor();
  // Markdown is parsed in a worker and code is highlighted after it: wait until no row shows its
  // plain-text fallback and no code block is still waiting for its colors.
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.md-fallback').length === 0 &&
      document.querySelectorAll('[data-testid="code-block"][data-highlight="pending"]').length ===
        0,
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

/** Elements inside the conversation column that are wider than their box (cut-off content). */
function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const column = document.querySelector('.conversation');
    if (column === null) return ['no conversation column'];
    const box = column.getBoundingClientRect();
    return [...column.querySelectorAll<HTMLElement>('*')]
      .filter((el) => el.offsetParent !== null)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const scrolls = ['auto', 'scroll'].includes(getComputedStyle(el).overflowX);
        return !scrolls && (r.right > box.right + 1 || r.left < box.left - 1) && r.width > 0;
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.getAttribute('class') ?? '').slice(0, 40)}`);
  });
}

test('session pane states for review', async ({ app, page }) => {
  test.setTimeout(900_000);
  await mkdir(EVIDENCE, { recursive: true });
  const problems: string[] = [];
  const themes = ['light', 'dark'] as const;
  const densities = QUICK ? (['comfortable'] as const) : (['comfortable', 'compact'] as const);
  const languages = QUICK ? (['en'] as const) : (['en', 'zh-CN'] as const);
  await resize(app, 1180, 820);
  for (const language of languages) {
    await prefer(page, { key: 'language', value: language });
    for (const density of densities) {
      await prefer(page, { key: 'appearance.density', value: density });
      for (const theme of themes) {
        await prefer(page, { key: 'appearance.theme', value: theme });
        for (const section of SECTIONS) {
          await open(page, section);
          const name = `${section}-${theme}-${density}-${language}`;
          await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
          for (const p of await overflow(page)) problems.push(`${name}: ${p}`);
        }
      }
    }
  }
  // The input's pickers and menus, open, in both themes.
  await prefer(page, { key: 'language', value: 'en' });
  await prefer(page, { key: 'appearance.density', value: 'comfortable' });
  for (const theme of themes) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await open(page, 'conversation');
    const editor = page.locator('.composer-editor');
    await editor.click();
    await page.keyboard.type('/');
    await page.getByTestId('command-popup').waitFor();
    await page.screenshot({ path: path.join(EVIDENCE, `picker-commands-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('@');
    await page.getByTestId('mention-popup').locator('[role="option"]').first().waitFor();
    await page.screenshot({ path: path.join(EVIDENCE, `picker-mentions-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    await page.getByTestId('composer-add').click();
    await page.screenshot({ path: path.join(EVIDENCE, `menu-add-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.getByTestId('permission-mode').click();
    await page.screenshot({ path: path.join(EVIDENCE, `menu-mode-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.getByTestId('session-model').click();
    await page.screenshot({ path: path.join(EVIDENCE, `menu-model-${theme}.png`) });
    await page.keyboard.press('Escape');
    await page.getByTestId('composer-add').hover();
    await page.locator('.tooltip[data-placed="true"]').waitFor();
    await page.screenshot({ path: path.join(EVIDENCE, `tooltip-${theme}.png`) });
  }
  // A narrow window, reduced motion and forced colors on the busiest sections.
  await prefer(page, { key: 'appearance.theme', value: 'light' });
  await resize(app, 560, 760);
  for (const section of SECTIONS.filter((s) => s !== 'thinking')) {
    await open(page, section);
    await page.screenshot({ path: path.join(EVIDENCE, `${section}-narrow.png`) });
    for (const p of await overflow(page)) problems.push(`${section}-narrow: ${p}`);
  }
  await resize(app, 1180, 820);
  await prefer(page, { key: 'appearance.reduceMotion', value: 'on' });
  await page.emulateMedia({ forcedColors: 'active' });
  for (const section of ['conversation', 'tools', 'approval-command', 'working']) {
    if (!SECTIONS.includes(section)) continue;
    await open(page, section);
    await page.screenshot({ path: path.join(EVIDENCE, `${section}-forced-colors.png`) });
  }
  await page.emulateMedia({ forcedColors: 'none' });
  await prefer(page, { key: 'appearance.reduceMotion', value: 'system' });
  expect(problems).toEqual([]);
});
