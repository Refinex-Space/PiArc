// The terminal's theme from the design tokens (T34): the component tokens `terminal.*`
// (`--piarc-c-terminal-*`, generated from design/tokens/component.json) resolved to RGB for
// the canvas and for Core's default colors. Any CSS color works (hex, `oklch()`, the system
// colors of Windows forced colors): a 1×1 canvas paints it and reads the pixel back.
import type { TerminalThemeColors } from '../../shared/ipc.js';
import type { ThemeColors } from './remote-renderable.js';
import type { RenderRgb } from './vendor/ghostty-web/renderer.js';

const TOKENS = {
  background: '--piarc-c-terminal-background',
  foreground: '--piarc-c-terminal-foreground',
  cursor: '--piarc-c-terminal-cursor',
  selection: '--piarc-c-terminal-selection',
  findMatch: '--piarc-c-terminal-find-match',
  findCurrent: '--piarc-c-terminal-find-current',
} as const satisfies Record<keyof ThemeColors, string>;

let probe: CanvasRenderingContext2D | null | undefined;

/** `color` (any CSS color) as RGB, or `undefined` when it does not parse. */
export function resolveColor(color: string): RenderRgb | undefined {
  if (color.trim() === '') return undefined;
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (probe === null) return undefined;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
  return a === 0 ? undefined : { r, g, b };
}

/** The theme as `element` sees the tokens now; `fallback` for a token that does not resolve. */
export function readTheme(element: Element, fallback: ThemeColors): ThemeColors {
  const style = getComputedStyle(element);
  const read = (key: keyof ThemeColors): RenderRgb =>
    resolveColor(style.getPropertyValue(TOKENS[key])) ?? fallback[key];
  return {
    background: read('background'),
    foreground: read('foreground'),
    cursor: read('cursor'),
    selection: read('selection'),
    findMatch: read('findMatch'),
    findCurrent: read('findCurrent'),
  };
}

const hex = (c: RenderRgb): number => (c.r << 16) | (c.g << 8) | c.b;

/** The default colors Core gives the terminal (`terminalColors`). */
export function coreColors(theme: ThemeColors): TerminalThemeColors {
  return {
    foreground: hex(theme.foreground),
    background: hex(theme.background),
    cursor: hex(theme.cursor),
  };
}
