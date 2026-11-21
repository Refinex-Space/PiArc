// T43: axe on the states of the accessibility state list (`a11y/states.ts`), in the light and
// the dark theme. Each check writes its axe result to tmp/evidence/<task>/axe/<state>-<theme>.json
// and records the state as checked; the suite's last test compares the checked states with the
// list, so a listed state no journey reaches fails.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { expect } from './fixtures.js';
import { A11Y_STATES, type A11yStateId } from './a11y/states.js';
import { prefer } from './t19.js';

const TASK = process.env.PIARC_EVIDENCE_TASK ?? 'L4';
export const AXE_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tmp',
  'evidence',
  TASK,
  'axe',
);

/** WCAG 2.x A and AA, and axe's best practices. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

export interface AxeSummary {
  readonly state: A11yStateId;
  readonly theme: 'light' | 'dark';
  readonly violations: readonly { id: string; impact: string | null; targets: string[] }[];
}

/** Runs axe on the page as it is now, in both themes; fails listing what it found. */
export async function checkState(
  page: Page,
  state: A11yStateId,
  options: { readonly include?: string } = {},
): Promise<void> {
  expect(
    A11Y_STATES.some((s) => s.id === state),
    `${state} is not in the state list`,
  ).toBe(true);
  await mkdir(AXE_DIR, { recursive: true });
  const found: AxeSummary[] = [];
  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', theme);
    // Let transitions settle so colors are measured at rest.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    let builder = new AxeBuilder({ page })
      // Electron cannot open the extra page axe merges results in; run axe in this page.
      .setLegacyMode(true)
      .withTags(TAGS);
    if (options.include !== undefined) builder = builder.include(options.include);
    const result = await builder.analyze();
    const file = path.join(AXE_DIR, `${state.replace(/[^a-z0-9-]+/giu, '_')}-${theme}.json`);
    await writeFile(
      file,
      JSON.stringify(
        {
          state,
          theme,
          url: result.url,
          violations: result.violations,
          passes: result.passes.length,
        },
        null,
        2,
      ),
    );
    found.push({
      state,
      theme,
      violations: result.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? null,
        targets: v.nodes.map((n) => n.target.join(' ')),
      })),
    });
  }
  await prefer(page, { key: 'appearance.theme', value: 'system' });
  await writeFile(path.join(AXE_DIR, `${state.replace(/[^a-z0-9-]+/giu, '_')}.checked`), '');
  // Soft: a journey goes on to its other states and reports all of them.
  expect
    .soft(
      found.filter((f) => f.violations.length > 0),
      `axe violations in ${state}`,
    )
    .toEqual([]);
}
