// Applies the appearance preferences to the document (architecture section 8.6): the color mode
// (`data-color-mode`: light or dark, each with a high-contrast variant), the accent
// (`data-accent`, ADR-0104; a custom color also sets `data-accent-color` and a style sheet that
// covers only the light and dark modes), the density, reduced motion and the platform. "System" choices follow `prefers-color-scheme`,
// `prefers-contrast` and `prefers-reduced-motion`; Windows forced colors are handled by the
// generated CSS itself. Components never read these: they read the semantic tokens.
import { DEFAULT_ACCENT, type ColorMode } from '../../shared/design-tokens.js';
import { isAccentColor, type Preferences } from '../../shared/preferences.js';
import { adoptCustomAccent } from './accent.js';

const DARK = '(prefers-color-scheme: dark)';
const MORE_CONTRAST = '(prefers-contrast: more)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** The color mode for the preferences and the system's current settings. */
export function colorMode(
  appearance: Preferences['appearance'],
  system: { readonly dark: boolean; readonly moreContrast: boolean },
): ColorMode {
  const dark = appearance.theme === 'system' ? system.dark : appearance.theme === 'dark';
  const high =
    appearance.contrast === 'system' ? system.moreContrast : appearance.contrast === 'high';
  if (dark) {
    return high ? 'darkHighContrast' : 'dark';
  }
  return high ? 'lightHighContrast' : 'light';
}

/** The `data-accent` value and the custom color it uses (`null`: a preset). */
export function accentOf(appearance: Preferences['appearance']): {
  readonly accent: string;
  readonly color: string | null;
} {
  if (appearance.accent !== 'custom') return { accent: appearance.accent, color: null };
  return isAccentColor(appearance.accentColor)
    ? { accent: 'custom', color: appearance.accentColor.toLowerCase() }
    : { accent: DEFAULT_ACCENT, color: null };
}

/** `mac`, `windows` or `linux`: selects the platform's window chrome styles. */
export function platformName(platform: string): string {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';
}

/**
 * Sets the data attributes on `root` and keeps them current while the system settings
 * change; returns the function that stops following them.
 */
export function applyAppearance(
  root: HTMLElement,
  platform: string,
  preferences: Preferences,
): () => void {
  const queries = [DARK, MORE_CONTRAST, REDUCED_MOTION].map((query) => window.matchMedia(query));
  const update = () => {
    const [dark, moreContrast, reduced] = queries.map((query) => query.matches);
    root.dataset.colorMode = colorMode(preferences.appearance, {
      dark: dark === true,
      moreContrast: moreContrast === true,
    });
    const accent = accentOf(preferences.appearance);
    root.dataset.accent = accent.accent;
    if (accent.color === null) delete root.dataset.accentColor;
    else root.dataset.accentColor = accent.color;
    adoptCustomAccent(root.ownerDocument, accent.color);
    root.dataset.density = preferences.appearance.density;
    const motion = preferences.appearance.reduceMotion;
    root.dataset.reduceMotion = String(motion === 'system' ? reduced === true : motion === 'on');
    root.dataset.platform = platformName(platform);
  };
  update();
  for (const query of queries) {
    query.addEventListener('change', update);
  }
  return () => {
    for (const query of queries) {
      query.removeEventListener('change', update);
    }
  };
}
