// The token colors of highlighted code (worker `workers/highlight.worker.ts`): GitHub's
// high-contrast light and dark themes, so tokens keep 4.5:1 on the code background and on the
// diff's added and removed tints in every color mode (T43; `themes.test.ts` checks it against the
// design tokens). The light theme's comment gray (#66707b, 4.39:1 on the removed tint) takes the
// theme's own darker gray.
import type { ThemeRegistration } from '@shikijs/core';

export const LIGHT_THEME = 'piarc-light';
export const DARK_THEME = 'github-dark-high-contrast';

const LIGHT_RECOLOR: Readonly<Record<string, string>> = { '#66707b': '#4b535d' };

function recolor(theme: ThemeRegistration, name: string): ThemeRegistration {
  const rules = theme.tokenColors?.map((rule) => {
    const foreground = rule.settings.foreground?.toLowerCase();
    const replaced = foreground === undefined ? undefined : LIGHT_RECOLOR[foreground];
    return replaced === undefined
      ? rule
      : { ...rule, settings: { ...rule.settings, foreground: replaced } };
  });
  return { ...theme, name, ...(rules === undefined ? {} : { tokenColors: rules }) };
}

/** Loaders of both themes for `createHighlighterCore`, named `LIGHT_THEME` and `DARK_THEME`. */
export const THEMES = [
  () =>
    import('@shikijs/themes/github-light-high-contrast').then((m) =>
      recolor(m.default, LIGHT_THEME),
    ),
  () => import('@shikijs/themes/github-dark-high-contrast').then((m) => m.default),
] as const;
