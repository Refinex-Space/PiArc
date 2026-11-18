import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MODES,
  buildModel,
  checkAssets,
  checkBrand,
  checkContrast,
  contrastRatio,
  cssVarName,
  hueAndSaturation,
  loadTokenSources,
  renderCss,
  renderTs,
} from './design-tokens.mjs';

describe('color math', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    // The WCAG reference: #767676 on white is just above 4.5:1.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  it('finds the HSL hue and saturation', () => {
    expect(hueAndSaturation('#ff8000').hue).toBeCloseTo(30, 0);
    expect(hueAndSaturation('#d97757').hue).toBeCloseTo(15, 0);
    expect(hueAndSaturation('#3b5bdb').hue).toBeCloseTo(228, 0);
    expect(hueAndSaturation('#808080').saturation).toBe(0);
  });
});

describe('the repository tokens', () => {
  it('resolve in all four modes and pass contrast and brand checks', async () => {
    const sources = await loadTokenSources();
    const model = buildModel(sources);
    for (const mode of MODES) {
      expect(Object.keys(model.colors[mode])).toEqual(model.colorNames);
    }
    expect(Object.keys(model.density.compact).sort()).toEqual(
      Object.keys(model.density.comfortable).sort(),
    );
    expect(checkContrast(model, sources.pairs).filter((r) => !r.ok)).toEqual([]);
    expect(checkBrand(model, sources)).toEqual([]);
  });

  it('render CSS blocks for every mode, compact density and forced colors', async () => {
    const model = buildModel(await loadTokenSources());
    const css = renderCss(model);
    for (const mode of MODES) {
      expect(css).toContain(`:root[data-color-mode='${mode}']`);
    }
    expect(css).toContain(":root[data-density='compact']");
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('--piarc-surface-app: Canvas;');
    expect(css).toContain('--piarc-c-sidebar-background: var(--piarc-surface-sidebar);');
    expect(renderTs(model)).toContain(
      "export type ColorToken =\n  | 'surface.app'".replace(/'/g, '"'),
    );
    expect(cssVarName('agentStatus.awaiting')).toBe('--piarc-agent-status-awaiting');
    expect(cssVarName('sidebar.rowHeight', true)).toBe('--piarc-c-sidebar-row-height');
  });
});

describe('the checks fail on bad tokens', () => {
  it('reports a pair below AA', async () => {
    const sources = await loadTokenSources();
    const palette = sources.palette.slate;
    if (palette === undefined || !Array.isArray(palette.light)) {
      throw new Error('slate ladder expected');
    }
    // Step 11 (secondary text) lightened until it no longer reaches 4.5:1.
    palette.light[10] = '#9a9ea6';
    const failing = checkContrast(buildModel(sources), sources.pairs).filter((r) => !r.ok);
    expect(failing.some((r) => r.fg === 'text.secondary' && r.mode === 'light')).toBe(true);
  });

  it('refuses an orange accent, a cream surface and a brand font', async () => {
    const sources = await loadTokenSources();
    const accent = sources.palette.indigo;
    const neutral = sources.palette.slate;
    if (
      accent === undefined ||
      !Array.isArray(accent.light) ||
      neutral === undefined ||
      !Array.isArray(neutral.light)
    ) {
      throw new Error('ladders expected');
    }
    accent.light[8] = '#d97757';
    neutral.light[0] = '#f5ecd9';
    const scale = sources.scale;
    scale.font = { ui: '"Styrene B", serif', mono: 'monospace' };
    const problems = checkBrand(buildModel(sources), sources);
    expect(problems.join('\n')).toMatch(/orange\/terracotta/);
    expect(problems.join('\n')).toMatch(/warm cream surface/);
    expect(problems.join('\n')).toMatch(/Styrene B/);
    expect(problems.join('\n')).toMatch(/serif family/);
  });

  it('finds bundled fonts, sounds and another brand’s icons', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'piarc tokens 资源-'));
    try {
      await mkdir(path.join(root, 'ui', 'assets'), { recursive: true });
      await writeFile(path.join(root, 'ui', 'assets', 'brand.woff2'), '');
      await writeFile(path.join(root, 'ui', 'assets', 'done.mp3'), '');
      await writeFile(path.join(root, 'ui', 'assets', 'claude-logo.svg'), '<svg/>');
      await writeFile(path.join(root, 'ui', 'claude-config.ts'), '');
      const problems = await checkAssets(root, ['ui']);
      expect(problems).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
