// T43: every token color of the highlight themes keeps 4.5:1 (WCAG AA for text) on the code
// background and on the diff's added and removed tints, in each color mode (the dark theme in the
// dark modes, the light theme in the light ones).
import { describe, expect, it } from 'vitest';

import { COLORS, COLOR_MODES } from '../../../shared/design-tokens.js';
import { THEMES } from './themes.js';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const value = parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

const BACKGROUNDS = ['code.background', 'diff.addedBackground', 'diff.removedBackground'] as const;

describe('highlight themes', () => {
  it('keep every token at 4.5:1 on the code and diff backgrounds', async () => {
    const [light, dark] = await Promise.all(THEMES.map((load) => load()));
    const failures: string[] = [];
    for (const mode of COLOR_MODES) {
      const theme = mode.startsWith('dark') ? dark : light;
      const colors = new Set<string>();
      for (const rule of theme?.tokenColors ?? []) {
        // A rule with its own background (invalid code, diff markup) brings its own contrast.
        const { foreground, background } = rule.settings;
        if (
          background === undefined &&
          foreground !== undefined &&
          /^#[0-9a-f]{6}$/iu.test(foreground)
        ) {
          colors.add(foreground.toLowerCase());
        }
      }
      expect(colors.size, mode).toBeGreaterThan(5);
      for (const token of BACKGROUNDS) {
        const background = COLORS[mode][token];
        for (const color of colors) {
          const ratio = contrast(color, background);
          if (ratio < 4.5)
            failures.push(`${mode} ${color} on ${token} ${background}: ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
