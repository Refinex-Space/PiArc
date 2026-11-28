// A custom accent (ADR-0104): the user's own color stands in for the accent ramp in the light
// and dark modes. Every accent color is derived from it and corrected until the contrast pairs
// the presets are checked against (`ACCENT_PAIRS`) hold: the solid is moved away from the
// canvas until it reads as a control, the text on it is black or white, links and the focus
// ring are darkened (light) or lightened (dark) to 4.5:1 and 3:1, and the selection tint is
// kept faint enough for text. The high-contrast modes and forced colors keep the default
// accent; so the rules are only for `light` and `dark`, outside forced colors.
import {
  ACCENT_PAIRS,
  ACCENT_TOKENS,
  COLORS,
  CONTRAST_MIN,
  CSS_VARS,
  type ColorToken,
} from '../../shared/design-tokens.js';

type BaseMode = 'light' | 'dark';

/** `#rrggbb`, lower case. */
export const ACCENT_COLOR = /^#[0-9a-f]{6}$/;

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two opaque colors. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `a` moved toward `b` by `t` (0–1), in sRGB. */
function mix(a: string, b: string, t: number): string {
  const from = channels(a);
  const to = channels(b);
  return `#${from
    .map((c, i) =>
      Math.round(c + ((to[i] ?? c) - c) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const BLACK = '#000000';
const WHITE = '#ffffff';

/**
 * The accent colors for `hex` in `mode`; other colors are the default ones (`COLORS`).
 */
export function customAccent(hex: string, mode: BaseMode): Record<ColorToken, string> {
  const base = COLORS[mode];
  const out: Partial<Record<ColorToken, string>> = {};
  const colorOf = (token: ColorToken) => out[token] ?? base[token];
  const pairsOf = (token: ColorToken) =>
    ACCENT_PAIRS.filter((pair) => pair.fg === token || pair.bg === token);
  const holds = (token: ColorToken) =>
    pairsOf(token).every(
      (pair) => contrastRatio(colorOf(pair.fg), colorOf(pair.bg)) >= CONTRAST_MIN[pair.kind],
    );
  // Away from the canvas: darker in light mode, lighter in dark mode.
  const away = mode === 'light' ? BLACK : WHITE;
  /** Moves `token` from `start` toward `target` until its pairs (among `checked`) hold. */
  const settle = (token: ColorToken, start: string, target: string, checked = holds) => {
    for (let t = 0; t <= 1.0001; t += 0.02) {
      out[token] = mix(start, target, Math.min(t, 1));
      if (checked(token)) return;
    }
    out[token] = target;
  };
  const accent = hex.toLowerCase();
  // The solid against the canvases only: its text is chosen next.
  const reads = (token: ColorToken) =>
    pairsOf(token)
      .filter((pair) => pair.fg === token)
      .every(
        (pair) => contrastRatio(colorOf(pair.fg), colorOf(pair.bg)) >= CONTRAST_MIN[pair.kind],
      );
  settle('accent.solid', accent, away, reads);
  const solid = colorOf('accent.solid');
  const onAccent = contrastRatio(solid, WHITE) >= contrastRatio(solid, BLACK) ? WHITE : BLACK;
  out['text.onAccent'] = onAccent;
  // Hover and pressed move away from the text, so they only gain contrast.
  const deeper = onAccent === WHITE ? BLACK : WHITE;
  out['accent.solidHover'] = mix(solid, deeper, 0.12);
  out['action.primaryPressed'] = mix(solid, deeper, 0.24);
  // The selection tint: as strong as text and status dots on it allow.
  const canvas = base['surface.app'];
  for (let t = mode === 'light' ? 0.16 : 0.28; t >= 0; t -= 0.02) {
    out['surface.selected'] = mix(canvas, solid, t);
    out['accent.subtleHover'] = out['surface.selected'];
    out['accent.subtle'] = mix(canvas, solid, t * 0.7);
    if (holds('surface.selected')) break;
  }
  settle('text.accent', accent, away);
  settle('border.focus', accent, away);
  return Object.fromEntries(ACCENT_TOKENS.map((token) => [token, colorOf(token)])) as Record<
    ColorToken,
    string
  >;
}

/** The style sheet text for a custom accent. */
export function customAccentCss(hex: string): string {
  const rules = (['light', 'dark'] as const).map((mode) => {
    const colors = customAccent(hex, mode);
    const lines = ACCENT_TOKENS.map((token) => `    ${CSS_VARS[token]}: ${colors[token]};`);
    return `  :root[data-accent='custom'][data-color-mode='${mode}'] {\n${lines.join('\n')}\n  }`;
  });
  return `@media not (forced-colors: active) {\n${rules.join('\n')}\n}\n`;
}

const sheets = new WeakMap<Document, CSSStyleSheet>();

/**
 * Applies the custom accent `hex` to `doc` (`null`: none) through a constructed style sheet;
 * the CSP's `style-src 'self'` does not cover it, and it comes after the token sheet.
 */
export function adoptCustomAccent(doc: Document, hex: string | null): void {
  let sheet = sheets.get(doc);
  if (sheet === undefined) {
    const view = doc.defaultView;
    if (hex === null || view === null) return;
    sheet = new view.CSSStyleSheet();
    sheets.set(doc, sheet);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  }
  sheet.replaceSync(hex === null ? '' : customAccentCss(hex));
}
