// The client's preferences (T18): what the user's settings file (`<data>/settings.json`) holds
// for the desktop client, their defaults and their validation. Core owns the file
// (`piarc_core::client_settings`); the main process reads it at start, writes single keys
// through Core and sends the result to every window.

import { isCommandId, parseKey } from './keybindings.js';

export const LANGUAGES = ['system', 'en', 'zh-CN'] as const;
export type LanguagePreference = (typeof LANGUAGES)[number];

export const THEMES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEMES)[number];

export const CONTRASTS = ['system', 'standard', 'high'] as const;
export type ContrastPreference = (typeof CONTRASTS)[number];

export const DENSITY_PREFERENCES = ['comfortable', 'compact'] as const;
export type DensityPreference = (typeof DENSITY_PREFERENCES)[number];

export const MOTIONS = ['system', 'on', 'off'] as const;
/** `on`: reduce motion; `off`: full motion; `system`: follow `prefers-reduced-motion`. */
export type ReduceMotionPreference = (typeof MOTIONS)[number];

export interface Preferences {
  readonly language: LanguagePreference;
  readonly appearance: {
    readonly theme: ThemePreference;
    readonly contrast: ContrastPreference;
    readonly density: DensityPreference;
    readonly reduceMotion: ReduceMotionPreference;
  };
  /** Command id → key in `Mod` notation; `''` unbinds. Only overrides are stored. */
  readonly keybindings: Readonly<Record<string, string>>;
  readonly notifications: { readonly enabled: boolean };
  readonly memory: { readonly readBoth: boolean };
  /** T23: offer Bypass permissions in the mode menu (the user's own file only). */
  readonly permissions: { readonly enableBypassPermissions: boolean };
  /** T37: the user's default output style (`outputStyle`); `''` when unset. Written through
   * Core's `setOutputStyle`, not as a preference change. */
  readonly outputStyle: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  language: 'system',
  appearance: {
    theme: 'system',
    contrast: 'system',
    density: 'comfortable',
    reduceMotion: 'system',
  },
  keybindings: {},
  notifications: { enabled: true },
  memory: { readBoth: false },
  permissions: { enableBypassPermissions: false },
  outputStyle: '',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * The preferences in a settings file object; missing or invalid values take their default
 * (the file is the user's and may be edited by hand).
 */
export function preferencesFrom(settings: unknown): Preferences {
  const file = isRecord(settings) ? settings : {};
  const appearance = isRecord(file.appearance) ? file.appearance : {};
  const notifications = isRecord(file.notifications) ? file.notifications : {};
  const keybindings: Record<string, string> = {};
  if (isRecord(file.keybindings)) {
    for (const [id, key] of Object.entries(file.keybindings)) {
      if (isCommandId(id) && typeof key === 'string' && (key === '' || parseKey(key))) {
        keybindings[id] = key;
      }
    }
  }
  const defaults = DEFAULT_PREFERENCES.appearance;
  return {
    language: oneOf(LANGUAGES, file.language, DEFAULT_PREFERENCES.language),
    appearance: {
      theme: oneOf(THEMES, appearance.theme, defaults.theme),
      contrast: oneOf(CONTRASTS, appearance.contrast, defaults.contrast),
      density: oneOf(DENSITY_PREFERENCES, appearance.density, defaults.density),
      reduceMotion: oneOf(MOTIONS, appearance.reduceMotion, defaults.reduceMotion),
    },
    keybindings,
    notifications: {
      enabled:
        typeof notifications.enabled === 'boolean'
          ? notifications.enabled
          : DEFAULT_PREFERENCES.notifications.enabled,
    },
    memory: { readBoth: isRecord(file.memory) && file.memory.readBoth === true },
    permissions: {
      enableBypassPermissions:
        isRecord(file.permissions) && file.permissions.enableBypassPermissions === true,
    },
    outputStyle: typeof file.outputStyle === 'string' ? file.outputStyle : '',
  };
}

/** One change the renderer asks for: a JSON Pointer in the settings file and its value. */
export type PreferenceChange =
  | { readonly key: 'language'; readonly value: LanguagePreference }
  | { readonly key: 'appearance.theme'; readonly value: ThemePreference }
  | { readonly key: 'appearance.contrast'; readonly value: ContrastPreference }
  | { readonly key: 'appearance.density'; readonly value: DensityPreference }
  | { readonly key: 'appearance.reduceMotion'; readonly value: ReduceMotionPreference }
  | { readonly key: 'notifications.enabled'; readonly value: boolean }
  | { readonly key: 'memory.readBoth'; readonly value: boolean }
  | { readonly key: 'permissions.enableBypassPermissions'; readonly value: boolean }
  /** `value` `null` restores the default key. */
  | { readonly key: 'keybinding'; readonly command: string; readonly value: string | null };

/**
 * Validates a change received over IPC and returns the settings-file pointer and value to
 * write (`null` removes the key), or `undefined` when it is not a valid change.
 */
export function pointerOf(change: unknown): { pointer: string; value: unknown } | undefined {
  if (!isRecord(change) || typeof change.key !== 'string') {
    return undefined;
  }
  const { key, value } = change;
  switch (key) {
    case 'language':
      return oneOf(LANGUAGES, value, 'system') === value
        ? { pointer: '/language', value }
        : undefined;
    case 'appearance.theme':
      return oneOf(THEMES, value, 'system') === value
        ? { pointer: '/appearance/theme', value }
        : undefined;
    case 'appearance.contrast':
      return oneOf(CONTRASTS, value, 'system') === value
        ? { pointer: '/appearance/contrast', value }
        : undefined;
    case 'appearance.density':
      return oneOf(DENSITY_PREFERENCES, value, 'comfortable') === value
        ? { pointer: '/appearance/density', value }
        : undefined;
    case 'appearance.reduceMotion':
      return oneOf(MOTIONS, value, 'system') === value
        ? { pointer: '/appearance/reduceMotion', value }
        : undefined;
    case 'notifications.enabled':
      return typeof value === 'boolean' ? { pointer: '/notifications/enabled', value } : undefined;
    case 'memory.readBoth':
      return typeof value === 'boolean' ? { pointer: '/memory/readBoth', value } : undefined;
    case 'permissions.enableBypassPermissions':
      return typeof value === 'boolean'
        ? { pointer: '/permissions/enableBypassPermissions', value }
        : undefined;
    case 'keybinding': {
      const { command } = change;
      if (!isCommandId(command)) {
        return undefined;
      }
      // Command ids use `.`, never `/` or `~`, so they are pointer-safe.
      const pointer = `/keybindings/${command}`;
      if (value === null) {
        return { pointer, value: null };
      }
      return typeof value === 'string' && (value === '' || parseKey(value) !== undefined)
        ? { pointer, value }
        : undefined;
    }
    default:
      return undefined;
  }
}
