import { describe, expect, it } from 'vitest';

import { ACCENT_PAIRS, ACCENT_TOKENS, COLORS, CONTRAST_MIN } from '../../shared/design-tokens.js';
import { contrastRatio, customAccent, customAccentCss } from './accent.js';

const SAMPLES = [
  '#000000',
  '#ffffff',
  '#ffff00',
  '#fff5cc',
  '#808080',
  '#10a37f',
  '#ff6b00',
  '#0a0a40',
  '#e11d48',
  '#7c3aed',
  '#3b82f6',
  '#22d3ee',
];

describe('a custom accent', () => {
  it('sets every accent color', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(Object.keys(customAccent('#10a37f', mode)).sort()).toEqual([...ACCENT_TOKENS].sort());
    }
  });

  it('keeps the chosen color when it already reads', () => {
    expect(customAccent('#3b5bdb', 'light')['accent.solid']).toBe('#3b5bdb');
  });

  it('meets every accent contrast pair in both modes, whatever the color', () => {
    for (const mode of ['light', 'dark'] as const) {
      for (const hex of SAMPLES) {
        const colors = { ...COLORS[mode], ...customAccent(hex, mode) };
        for (const pair of ACCENT_PAIRS) {
          const ratio = contrastRatio(colors[pair.fg], colors[pair.bg]);
          expect
            .soft(ratio, `${hex} ${mode}: ${pair.fg} on ${pair.bg}`)
            .toBeGreaterThanOrEqual(CONTRAST_MIN[pair.kind]);
        }
      }
    }
  });

  it('picks dark text on light solids and white on dark ones', () => {
    expect(customAccent('#ffff00', 'dark')['text.onAccent']).toBe('#000000');
    expect(customAccent('#0a0a40', 'dark')['text.onAccent']).toBe('#ffffff');
  });

  it('renders rules for the two normal modes only, outside forced colors', () => {
    const css = customAccentCss('#10a37f');
    expect(css).toContain('@media not (forced-colors: active)');
    expect(css).toContain(":root[data-accent='custom'][data-color-mode='light']");
    expect(css).toContain(":root[data-accent='custom'][data-color-mode='dark']");
    expect(css).not.toContain('HighContrast');
    expect(css).toContain('--piarc-accent-solid: #10a37f;');
  });

  it('measures WCAG contrast', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThan(4.5);
  });
});
