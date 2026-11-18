// Design tokens (architecture section 8.6): loads the four layers in design/tokens/ (palette →
// light/dark ramps → semantic colors → component tokens, plus the mode-independent scale and
// density values), resolves them for the four color modes, renders the CSS custom properties
// and the TypeScript constants, and checks WCAG contrast, the brand rules and the bundled
// assets. `scripts/dev/gen-design-tokens.mjs` writes the outputs;
// `scripts/ci/check-design-tokens.mjs` (a verify step) checks drift, contrast and brand.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { isRecord, readJsonFile, repoRoot } from './repo.mjs';

/** The token sources. */
export const TOKENS_DIR = path.join(repoRoot, 'design', 'tokens');

/** Generated files, relative to the repository root. */
export const OUTPUTS = {
  css: path.join('apps', 'desktop', 'src', 'renderer', 'theme', 'tokens.generated.css'),
  ts: path.join('apps', 'desktop', 'src', 'shared', 'design-tokens.ts'),
};

/** Color modes: light and dark, each with a high-contrast variant. */
export const MODES = /** @type {const} */ ([
  'light',
  'dark',
  'lightHighContrast',
  'darkHighContrast',
]);

/** @typedef {(typeof MODES)[number]} Mode */

/** Densities; the first is the default. */
export const DENSITIES = /** @type {const} */ (['comfortable', 'compact']);

/** @typedef {(typeof DENSITIES)[number]} Density */

/** WCAG 2.2 minimum ratios by pair kind: normal and high-contrast modes. */
export const CONTRAST_MIN = {
  normal: { text: 4.5, large: 3, ui: 3 },
  highContrast: { text: 7, large: 4.5, ui: 3 },
};

/**
 * PiArc's brand boundary (ADR-0006, architecture section 8.6, ui-reference-notes section 9):
 * the accent stays out of the orange and terracotta hues, surfaces are not warm cream, and
 * no Anthropic font, serif display font, icon or sound ships.
 */
export const BRAND_RULES = {
  /** HSL hues (degrees, inclusive) the accent may not use: orange, terracotta, clay. */
  forbiddenAccentHues: { from: 10, to: 50 },
  /** Below this HSL saturation a color is a gray and has no meaningful hue. */
  minSaturation: 0.2,
  /** Warm cream: surfaces with this hue range and saturation are refused. */
  creamSurface: { from: 25, to: 60, minSaturation: 0.25 },
  /** Font families that must not appear in the font stacks (lower case). */
  forbiddenFonts: [
    'styrene',
    'tiempos',
    'copernicus',
    'anthropic sans',
    'anthropic serif',
    'anthropic mono',
    'galaxie copernicus',
  ],
  /** File extensions that may not be bundled: fonts (system fonts only) and sounds. */
  forbiddenAssetExtensions: [
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
    '.eot',
    '.mp3',
    '.wav',
    '.ogg',
    '.aiff',
    '.aif',
    '.m4a',
    '.caf',
    '.flac',
  ],
  /** Image and icon names that suggest another brand's assets (lower case substrings). */
  forbiddenAssetNames: ['claude', 'anthropic'],
  /** Extensions the name check applies to: images and icons. */
  imageExtensions: ['.png', '.svg', '.icns', '.ico', '.jpg', '.jpeg', '.gif', '.webp'],
  /** Directories whose files ship with the app or define its look. */
  assetRoots: [
    path.join('apps', 'desktop', 'src'),
    path.join('apps', 'desktop', 'packaging'),
    'design',
  ],
};

/**
 * @typedef {object} TokenSources
 * @property {Record<string, { light: string[], dark: string[] } | Record<string, string>>} palette
 * @property {Record<string, string>} ramps role → palette family
 * @property {Record<string, unknown>} semantic
 * @property {Record<string, unknown>} component
 * @property {Record<string, unknown>} scale
 * @property {{ fg: string, bg: string, kind: 'text' | 'large' | 'ui' }[]} pairs
 */

/**
 * @typedef {object} TokenModel
 * @property {string[]} colorNames semantic color tokens, `group.name`
 * @property {Record<Mode, Record<string, string>>} colors resolved hex per mode
 * @property {Record<string, string>} forced token → CSS system color
 * @property {Record<string, string>} common mode- and density-independent scale values
 * @property {Record<Density, Record<string, string>>} density
 * @property {Record<string, string>} component component token → referenced token
 * @property {Record<string, string>} ramps role → palette family
 */

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
function record(value, where) {
  if (!isRecord(value)) {
    throw new Error(`${where} must be a JSON object`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} where
 */
function text(value, where) {
  if (typeof value !== 'string') {
    throw new Error(`${where} must be a string`);
  }
  return value;
}

/**
 * Entries of a token file without its `$description`.
 * @param {Record<string, unknown>} object
 */
function entries(object) {
  return Object.entries(object).filter(([key]) => !key.startsWith('$'));
}

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/;

/**
 * Reads and shape-checks the token files.
 * @param {string} [dir]
 * @returns {Promise<TokenSources>}
 */
export async function loadTokenSources(dir = TOKENS_DIR) {
  const read = async (/** @type {string} */ name) =>
    record(await readJsonFile(path.join(dir, name)), name);
  const [paletteFile, rampsFile, semantic, component, scale, contrastFile] = await Promise.all([
    read('palette.json'),
    read('ramps.json'),
    read('semantic.json'),
    read('component.json'),
    read('scale.json'),
    read('contrast.json'),
  ]);
  /** @type {TokenSources['palette']} */
  const palette = {};
  for (const [family, value] of entries(paletteFile)) {
    const shape = record(value, `palette.${family}`);
    if (Array.isArray(shape.light) || Array.isArray(shape.dark)) {
      const ladder = (/** @type {'light' | 'dark'} */ side) => {
        const steps = shape[side];
        if (!Array.isArray(steps) || steps.length !== 12) {
          throw new Error(`palette.${family}.${side} must list 12 colors`);
        }
        return steps.map((step, i) => hex(step, `palette.${family}.${side}[${String(i)}]`));
      };
      palette[family] = { light: ladder('light'), dark: ladder('dark') };
    } else {
      palette[family] = Object.fromEntries(
        entries(shape).map(([name, color]) => [name, hex(color, `palette.${family}.${name}`)]),
      );
    }
  }
  /** @type {Record<string, string>} */
  const ramps = {};
  for (const [role, family] of entries(rampsFile)) {
    const name = text(family, `ramps.${role}`);
    const target = palette[name];
    if (target === undefined || !('light' in target) || !Array.isArray(target.light)) {
      throw new Error(`ramps.${role} names ${name}, which is not a palette ladder`);
    }
    ramps[role] = name;
  }
  const rawPairs = contrastFile.pairs;
  if (!Array.isArray(rawPairs)) {
    throw new Error('contrast.json must have a pairs list');
  }
  const pairs = rawPairs.map((pair, i) => {
    const where = `contrast.pairs[${String(i)}]`;
    const shape = record(pair, where);
    const kind = text(shape.kind, `${where}.kind`);
    /** @type {'text' | 'large' | 'ui'} */
    let checked;
    if (kind === 'text' || kind === 'large' || kind === 'ui') {
      checked = kind;
    } else {
      throw new Error(`${where}.kind must be text, large or ui`);
    }
    return { fg: text(shape.fg, `${where}.fg`), bg: text(shape.bg, `${where}.bg`), kind: checked };
  });
  return { palette, ramps, semantic, component, scale, pairs };
}

/**
 * @param {unknown} value
 * @param {string} where
 */
function hex(value, where) {
  const color = text(value, where).toLowerCase();
  if (!HEX.test(color)) {
    throw new Error(`${where} must be #rrggbb or #rrggbbaa, found ${color}`);
  }
  return color;
}

/**
 * @param {Mode} mode
 * @returns {'light' | 'dark'}
 */
function baseOf(mode) {
  return mode === 'light' || mode === 'lightHighContrast' ? 'light' : 'dark';
}

/**
 * The reference a semantic value gives for `mode`.
 * @param {unknown} value
 * @param {Mode} mode
 * @param {string} where
 */
function referenceFor(value, mode, where) {
  if (typeof value === 'string') {
    return value;
  }
  const byMode = record(value, where);
  const highContrast = mode === 'lightHighContrast' || mode === 'darkHighContrast';
  const candidates = highContrast ? [mode, 'highContrast', baseOf(mode)] : [mode];
  for (const key of candidates) {
    if (key in byMode) {
      return text(byMode[key], `${where}.${key}`);
    }
  }
  throw new Error(`${where} has no value for ${mode}`);
}

/**
 * Resolves `role.step` (a ramp step) or `family.name` (a fixed palette color) in `mode`.
 * @param {TokenSources} sources
 * @param {string} reference
 * @param {Mode} mode
 * @param {string} where
 */
function resolveReference(sources, reference, mode, where) {
  const [head, tail, extra] = reference.split('.');
  if (head === undefined || tail === undefined || extra !== undefined) {
    throw new Error(`${where}: ${reference} is not <role>.<step> or <family>.<name>`);
  }
  const family = sources.ramps[head];
  if (family !== undefined) {
    const step = Number(tail);
    const ladder = sources.palette[family];
    const steps = ladder !== undefined && 'light' in ladder ? ladder[baseOf(mode)] : undefined;
    const color = Number.isInteger(step) && Array.isArray(steps) ? steps[step - 1] : undefined;
    if (typeof color !== 'string') {
      throw new Error(`${where}: ${reference} is not a step 1-12 of ramp ${head}`);
    }
    return color;
  }
  const fixed = sources.palette[head];
  const color = fixed !== undefined && !('light' in fixed) ? fixed[tail] : undefined;
  if (typeof color !== 'string') {
    throw new Error(`${where}: ${reference} names no ramp step or palette color`);
  }
  return color;
}

/**
 * Flattens a scale group into `group.name` → value.
 * @param {Record<string, unknown>} group
 * @param {string} prefix
 * @param {Record<string, string>} into
 */
function flatten(group, prefix, into) {
  for (const [key, value] of entries(group)) {
    const name = `${prefix}${key}`;
    if (typeof value === 'string') {
      into[name] = value;
    } else {
      flatten(record(value, name), `${name}.`, into);
    }
  }
}

/**
 * Resolves every layer into the model the renderers and checks use.
 * @param {TokenSources} sources
 * @returns {TokenModel}
 */
export function buildModel(sources) {
  /** @type {string[]} */
  const colorNames = [];
  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {Record<string, string>} */
  const forced = {};
  for (const [group, tokens] of entries(sources.semantic)) {
    if (group === 'forcedColors') {
      for (const [token, keyword] of entries(record(tokens, 'forcedColors'))) {
        forced[token] = text(keyword, `forcedColors.${token}`);
      }
      continue;
    }
    for (const [name, value] of entries(record(tokens, `semantic.${group}`))) {
      colorNames.push(`${group}.${name}`);
      values[`${group}.${name}`] = value;
    }
  }
  for (const token of Object.keys(forced)) {
    if (!colorNames.includes(token)) {
      throw new Error(`forcedColors.${token} is not a semantic color`);
    }
  }
  const colors = /** @type {Record<Mode, Record<string, string>>} */ ({});
  for (const mode of MODES) {
    colors[mode] = Object.fromEntries(
      colorNames.map((token) => {
        const reference = referenceFor(values[token], mode, `semantic.${token}`);
        return [token, resolveReference(sources, reference, mode, `semantic.${token}`)];
      }),
    );
  }
  /** @type {Record<string, string>} */
  const common = {};
  const { density: densityGroup, ...rest } = sources.scale;
  flatten(rest, '', common);
  const densityValues = record(densityGroup, 'scale.density');
  const density = /** @type {Record<Density, Record<string, string>>} */ ({});
  for (const name of DENSITIES) {
    /** @type {Record<string, string>} */
    const flat = {};
    flatten(record(densityValues[name], `scale.density.${name}`), '', flat);
    density[name] = flat;
  }
  const densityKeys = Object.keys(density.comfortable).sort().join(',');
  for (const name of DENSITIES) {
    if (Object.keys(density[name]).sort().join(',') !== densityKeys) {
      throw new Error(`scale.density.${name} must define the same keys as comfortable`);
    }
  }
  /** @type {Record<string, string>} */
  const component = {};
  for (const [part, tokens] of entries(sources.component)) {
    for (const [name, reference] of entries(record(tokens, `component.${part}`))) {
      const target = text(reference, `component.${part}.${name}`);
      if (!colorNames.includes(target) && !(target in common) && !(target in density.comfortable)) {
        throw new Error(`component.${part}.${name} refers to unknown token ${target}`);
      }
      component[`${part}.${name}`] = target;
    }
  }
  return { colorNames, colors, forced, common, density, component, ramps: sources.ramps };
}

/**
 * The CSS custom property of a token: `surface.app` → `--piarc-surface-app`; component tokens
 * get `--piarc-c-`.
 * @param {string} token
 * @param {boolean} [isComponent]
 */
export function cssVarName(token, isComponent = false) {
  const kebab = token
    .split('.')
    .map((part) => part.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
    .join('-');
  return `--piarc-${isComponent ? 'c-' : ''}${kebab}`;
}

/**
 * @param {Record<string, string>} values
 * @param {string} indent
 */
function declarations(values, indent) {
  return Object.entries(values)
    .map(([token, value]) => `${indent}${cssVarName(token)}: ${value};`)
    .join('\n');
}

const HEADER = 'Generated by scripts/dev/gen-design-tokens.mjs from design/tokens/. Do not edit.';

/**
 * The CSS custom properties: scale and component tokens on `:root`, colors per
 * `data-color-mode` (with a media-query fallback before the attribute is set), density per
 * `data-density`, and system colors under forced colors.
 * @param {TokenModel} model
 */
export function renderCss(model) {
  const scheme = (/** @type {Mode} */ mode) => `color-scheme: ${baseOf(mode)};`;
  const block = (/** @type {string} */ selector, /** @type {string} */ body) =>
    `${selector} {\n${body}\n}`;
  const modeBody = (/** @type {Mode} */ mode, /** @type {string} */ indent) =>
    `${indent}${scheme(mode)}\n${declarations(model.colors[mode], indent)}`;
  const componentLines = Object.entries(model.component)
    .map(([token, target]) => `  ${cssVarName(token, true)}: var(${cssVarName(target)});`)
    .join('\n');
  const parts = [
    `/* ${HEADER} */`,
    block(
      ':root',
      [
        declarations(model.common, '  '),
        declarations(model.density.comfortable, '  '),
        componentLines,
        modeBody('light', '  '),
      ].join('\n'),
    ),
    `@media (prefers-color-scheme: dark) {\n${block(
      '  :root:not([data-color-mode])',
      modeBody('dark', '    '),
    ).replace(/\n}$/, '\n  }')}\n}`,
    ...MODES.map((mode) => block(`:root[data-color-mode='${mode}']`, modeBody(mode, '  '))),
    ...DENSITIES.slice(1).map((density) =>
      block(`:root[data-density='${density}']`, declarations(model.density[density], '  ')),
    ),
    `@media (forced-colors: active) {\n${block(
      '  :root,\n  :root[data-color-mode]',
      declarations(model.forced, '    '),
    ).replace(/\n}$/, '\n  }')}\n}`,
  ];
  return `${parts.join('\n\n')}\n`;
}

/**
 * The TypeScript constants (shared by the main process and the renderer).
 * @param {TokenModel} model
 */
export function renderTs(model) {
  const union = (/** @type {string[]} */ names) =>
    names.map((name) => `  | ${JSON.stringify(name)}`).join('\n');
  const scaleNames = [...Object.keys(model.common), ...Object.keys(model.density.comfortable)];
  const componentNames = Object.keys(model.component);
  return `// ${HEADER}

/** Color modes: light and dark, each with a high-contrast variant. */
export const COLOR_MODES = ${JSON.stringify(MODES)} as const;
export type ColorMode = (typeof COLOR_MODES)[number];

/** Densities; the first is the default. */
export const DENSITIES = ${JSON.stringify(DENSITIES)} as const;
export type Density = (typeof DENSITIES)[number];

/** Semantic colors (the only colors components read). */
export type ColorToken =
${union(model.colorNames)};

/** Mode- and density-dependent sizes, fonts and motion values. */
export type ScaleToken =
${union(scaleNames)};

/** Component tokens. */
export type ComponentToken =
${union(componentNames)};

/** Resolved colors per mode (for the main process: window backgrounds, title bar overlays). */
export const COLORS: Readonly<Record<ColorMode, Readonly<Record<ColorToken, string>>>> = ${JSON.stringify(
    model.colors,
  )};

/** The CSS custom property of a token. */
export const CSS_VARS: Readonly<Record<ColorToken | ScaleToken | ComponentToken, string>> = ${JSON.stringify(
    Object.fromEntries([
      ...model.colorNames.map((name) => [name, cssVarName(name)]),
      ...scaleNames.map((name) => [name, cssVarName(name)]),
      ...componentNames.map((name) => [name, cssVarName(name, true)]),
    ]),
  )};

/** \`var(--piarc-…)\` for a token, for inline styles. */
export function tokenVar(token: ColorToken | ScaleToken | ComponentToken): string {
  return \`var(\${CSS_VARS[token]})\`;
}
`;
}

// ---- color math (WCAG 2.2) ----

/**
 * @param {string} color #rrggbb
 * @returns {{ r: number, g: number, b: number }} 0-255
 */
function rgb(color) {
  const channel = (/** @type {number} */ i) => parseInt(color.slice(i, i + 2), 16);
  return { r: channel(1), g: channel(3), b: channel(5) };
}

/**
 * WCAG relative luminance of an opaque color.
 * @param {string} color
 */
export function luminance(color) {
  const linear = (/** @type {number} */ channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const { r, g, b } = rgb(color);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * WCAG contrast ratio of two opaque colors.
 * @param {string} a
 * @param {string} b
 */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * HSL hue (degrees) and saturation (0-1) of a color.
 * @param {string} color
 */
export function hueAndSaturation(color) {
  const channels = rgb(color);
  const r = channels.r / 255;
  const g = channels.g / 255;
  const b = channels.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) {
    return { hue: 0, saturation: 0 };
  }
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === r) {
    hue = ((g - b) / delta) % 6;
  } else if (max === g) {
    hue = (b - r) / delta + 2;
  } else {
    hue = (r - g) / delta + 4;
  }
  hue *= 60;
  return { hue: hue < 0 ? hue + 360 : hue, saturation };
}

/**
 * @typedef {object} ContrastResult
 * @property {Mode} mode
 * @property {string} fg
 * @property {string} bg
 * @property {'text' | 'large' | 'ui'} kind
 * @property {number} ratio
 * @property {number} required
 * @property {boolean} ok
 */

/**
 * Measures every declared pair in every mode.
 * @param {TokenModel} model
 * @param {TokenSources['pairs']} pairs
 * @returns {ContrastResult[]}
 */
export function checkContrast(model, pairs) {
  /** @type {ContrastResult[]} */
  const results = [];
  for (const mode of MODES) {
    const minimum =
      mode === 'lightHighContrast' || mode === 'darkHighContrast'
        ? CONTRAST_MIN.highContrast
        : CONTRAST_MIN.normal;
    for (const pair of pairs) {
      const fg = model.colors[mode][pair.fg];
      const bg = model.colors[mode][pair.bg];
      if (fg === undefined || bg === undefined) {
        throw new Error(`contrast pair ${pair.fg} on ${pair.bg} names an unknown token`);
      }
      if (fg.length !== 7 || bg.length !== 7) {
        throw new Error(`contrast pair ${pair.fg} on ${pair.bg} uses a color with alpha`);
      }
      const ratio = contrastRatio(fg, bg);
      const required = minimum[pair.kind];
      results.push({ mode, ...pair, ratio, required, ok: ratio >= required });
    }
  }
  return results;
}

/**
 * Brand rules on the resolved tokens: accent hues, cream surfaces, font stacks.
 * @param {TokenModel} model
 * @param {TokenSources} sources
 * @returns {string[]} problems
 */
export function checkBrand(model, sources) {
  /** @type {string[]} */
  const problems = [];
  const { forbiddenAccentHues: band, minSaturation, creamSurface } = BRAND_RULES;
  const inBand = (/** @type {number} */ hue, /** @type {{ from: number, to: number }} */ b) =>
    hue >= b.from && hue <= b.to;
  const accentFamily = sources.ramps.accent;
  const ladder = accentFamily === undefined ? undefined : sources.palette[accentFamily];
  if (ladder === undefined || !Array.isArray(ladder.light) || !Array.isArray(ladder.dark)) {
    problems.push('ramps.accent must name a palette ladder');
  } else {
    for (const steps of [ladder.light, ladder.dark]) {
      const side = steps === ladder.light ? 'light' : 'dark';
      steps.forEach((/** @type {string} */ color, /** @type {number} */ i) => {
        const { hue, saturation } = hueAndSaturation(color.slice(0, 7));
        if (saturation >= minSaturation && inBand(hue, band)) {
          problems.push(
            `accent ${String(accentFamily)}.${side}[${String(i + 1)}] ${color} has hue ${hue.toFixed(0)}°, ` +
              `inside the forbidden orange/terracotta range ${String(band.from)}–${String(band.to)}°`,
          );
        }
      });
    }
  }
  for (const mode of MODES) {
    for (const [token, color] of Object.entries(model.colors[mode])) {
      const isAccent = token.startsWith('accent.') || token === 'text.accent';
      const { hue, saturation } = hueAndSaturation(color.slice(0, 7));
      if (isAccent && saturation >= minSaturation && inBand(hue, band)) {
        problems.push(`${token} in ${mode} is ${color}, an orange/terracotta hue`);
      }
      if (
        token.startsWith('surface.') &&
        saturation >= creamSurface.minSaturation &&
        inBand(hue, creamSurface)
      ) {
        problems.push(`${token} in ${mode} is ${color}, a warm cream surface`);
      }
    }
  }
  for (const [token, value] of Object.entries(model.common)) {
    if (!token.startsWith('font.')) {
      continue;
    }
    const families = value.split(',').map((family) => family.trim().replace(/^"|"$/g, ''));
    for (const family of families) {
      const lower = family.toLowerCase();
      if (BRAND_RULES.forbiddenFonts.some((forbidden) => lower.includes(forbidden))) {
        problems.push(`${token} uses ${family}, a font PiArc may not use`);
      }
      if (lower === 'serif' || lower.endsWith(' serif')) {
        problems.push(`${token} uses a serif family (${family}); PiArc uses system sans fonts`);
      }
    }
  }
  return problems;
}

/**
 * Files under `roots` that are fonts, sounds or named after another brand.
 * @param {string} root the repository
 * @param {string[]} [roots]
 * @returns {Promise<string[]>} problems
 */
export async function checkAssets(root, roots = BRAND_RULES.assetRoots) {
  /** @type {string[]} */
  const problems = [];
  /** @param {string} dir */
  const walk = async (dir) => {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name !== 'node_modules') {
          await walk(full);
        }
        continue;
      }
      const lower = dirent.name.toLowerCase();
      const shown = path.relative(root, full);
      if (BRAND_RULES.forbiddenAssetExtensions.includes(path.extname(lower))) {
        problems.push(`${shown}: fonts and sounds are not bundled (system fonts only)`);
      }
      const isImage = BRAND_RULES.imageExtensions.includes(path.extname(lower));
      if (isImage && BRAND_RULES.forbiddenAssetNames.some((name) => lower.includes(name))) {
        problems.push(`${shown}: the file name suggests another brand's asset`);
      }
    }
  };
  for (const dir of roots) {
    await walk(path.join(root, dir));
  }
  return problems;
}
