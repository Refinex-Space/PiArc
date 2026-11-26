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
  /** T23: offer Bypass permissions in the mode menu (the user's own file only); T46: Auto
   * mode is enabled (the main process confirms natively before it writes `true`). */
  readonly permissions: {
    readonly enableBypassPermissions: boolean;
    readonly enableAutoMode: boolean;
  };
  /** T46: Auto mode's reviewer and the user's review policy (PiArc's user file). */
  readonly autoMode: AutoModePreferences;
  /** T37: the user's default output style (`outputStyle`); `''` when unset. Written through
   * Core's `setOutputStyle`, not as a preference change. */
  readonly outputStyle: string;
  /** ADR-0082: the Agent Hosts' proxy: the system's (`auto`, the default) or `url`. */
  readonly proxy: { readonly mode: ProxyMode; readonly url: string };
  /** ADR-0085: the Git panel's settings (the user's file; Core reads the same keys). */
  readonly git: GitPreferences;
}

/** How a pull integrates the upstream (`config` follows `pull.rebase` and `pull.ff`). */
export const PULL_MODES = ['config', 'merge', 'rebase', 'ffOnly'] as const;
export type PullMode = (typeof PULL_MODES)[number];

/** Minutes between automatic fetches; 0 is off (design addendum H5). */
export const AUTO_FETCH_MINUTES = [0, 5, 15, 30, 60] as const;
export type AutoFetchMinutes = (typeof AUTO_FETCH_MINUTES)[number];

/** How a pull request is merged on GitHub (G5). */
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** Where AI review findings appear (G5). */
export const REVIEW_PRESENTATIONS = ['inline', 'separate'] as const;
export type ReviewPresentation = (typeof REVIEW_PRESENTATIONS)[number];

export interface GitPreferences {
  /** Prefilled when a branch is created; `''` when unset. */
  readonly branchPrefix: string;
  /** Branch name patterns (`*` matches any run) that are never force-pushed. */
  readonly protectedBranches: readonly string[];
  readonly pullMode: PullMode;
  readonly alwaysForcePush: boolean;
  /** `''`: the interface language's default instructions. */
  readonly commitInstructions: string;
  readonly autoFetch: AutoFetchMinutes;
  readonly mergeMethod: MergeMethod;
  readonly draftPullRequests: boolean;
  /** `''`: the interface language's default instructions. */
  readonly prInstructions: string;
  readonly reviewPresentation: ReviewPresentation;
}

/** Bounds of the Git settings (Core cuts the same values at its own limits). */
export const GIT_LIMITS = {
  prefix: 64,
  patterns: 32,
  pattern: 255,
  instructions: 8 * 1024,
} as const;

export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];

/** Whether `text` can start a branch name: no spaces, controls or characters Git refuses. */
export function isBranchPrefix(text: string): boolean {
  return (
    text.length <= GIT_LIMITS.prefix &&
    !text.startsWith('-') &&
    !text.startsWith('/') &&
    !text.includes('..') &&
    !text.includes('//') &&
    // eslint-disable-next-line no-control-regex -- control characters are what it refuses
    !/[\s~^:?*[\\\x00-\x1f\x7f]/u.test(text)
  );
}

/** Whether `text` is a protected-branch pattern. */
export function isBranchPattern(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= GIT_LIMITS.pattern &&
    // eslint-disable-next-line no-control-regex -- control characters are what it refuses
    !/[\s\x00-\x1f\x7f]/u.test(text)
  );
}

/** How the Agent Hosts find their proxy (ADR-0082). */
export const PROXY_MODES = ['auto', 'manual'] as const;
export type ProxyMode = (typeof PROXY_MODES)[number];

/** Why a proxy address is refused (Core's `network::check_url`, which has the last word). */
export type ProxyUrlProblem = 'scheme' | 'host' | 'port' | 'credentials' | 'path';

/**
 * The problem with `text` as a proxy address, or `undefined` when it is `http(s)://host[:port]`
 * without credentials or a path (the same rules as Core's check).
 */
export function proxyUrlProblem(text: string): ProxyUrlProblem | undefined {
  const match = /^(https?):\/\/([^/?#]*)([/?#].*)?$/iu.exec(text.trim());
  if (match === null) return 'scheme';
  const authority = match[2] ?? '';
  const tail = match[3] ?? '';
  if (tail !== '' && tail !== '/') return 'path';
  if (authority.includes('@')) return 'credentials';
  const bracketed = /^\[([0-9a-f:.]+)\](?::(.*))?$/iu.exec(authority);
  const plain = /^([a-z0-9.-]+)(?::(.*))?$/iu.exec(authority);
  const parts = bracketed ?? plain;
  if (parts === null || (parts[1] ?? '') === '') return 'host';
  const port = parts[2];
  if (port === undefined) return undefined;
  const number = /^\d{1,5}$/u.test(port) ? Number(port) : 0;
  return number >= 1 && number <= 65535 ? undefined : 'port';
}

/** The four lists of `autoMode` (T46), by their settings key. */
export const AUTO_MODE_LISTS = ['environment', 'allow', 'soft_deny', 'hard_deny'] as const;
export type AutoModeList = (typeof AUTO_MODE_LISTS)[number];

export interface AutoModePreferences {
  /** `provider/model`; `''` when unset. */
  readonly model: string;
  readonly lists: Readonly<Record<AutoModeList, readonly string[]>>;
}

/** Bounds of one policy entry and of a list (Core cuts the review input at its own limits). */
export const AUTO_MODE_ENTRY_CHARS = 500;
export const AUTO_MODE_LIST_ENTRIES = 100;

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
  permissions: { enableBypassPermissions: false, enableAutoMode: false },
  autoMode: {
    model: '',
    lists: { environment: [], allow: [], soft_deny: [], hard_deny: [] },
  },
  outputStyle: '',
  proxy: { mode: 'auto', url: '' },
  git: {
    branchPrefix: '',
    protectedBranches: DEFAULT_PROTECTED_BRANCHES,
    pullMode: 'config',
    alwaysForcePush: false,
    commitInstructions: '',
    autoFetch: 0,
    mergeMethod: 'squash',
    draftPullRequests: false,
    prInstructions: '',
    reviewPresentation: 'inline',
  },
};

/** A `provider/model` reference as the reviewer setting takes it (no alias). */
export function isModelReference(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && /^[^\s/]+\/\S+$/u.test(value);
}

function isPolicyList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= AUTO_MODE_LIST_ENTRIES &&
    value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.trim() !== '' &&
        Array.from(entry).length <= AUTO_MODE_ENTRY_CHARS,
    )
  );
}

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
      enableAutoMode: isRecord(file.permissions) && file.permissions.enableAutoMode === true,
    },
    autoMode: autoModeFrom(file.autoMode),
    outputStyle: typeof file.outputStyle === 'string' ? file.outputStyle : '',
    proxy: {
      mode: oneOf(PROXY_MODES, isRecord(file.proxy) ? file.proxy.mode : undefined, 'auto'),
      url: isRecord(file.proxy) && typeof file.proxy.url === 'string' ? file.proxy.url : '',
    },
    git: gitFrom(file.git),
  };
}

function gitFrom(value: unknown): GitPreferences {
  const git = isRecord(value) ? value : {};
  const defaults = DEFAULT_PREFERENCES.git;
  return {
    branchPrefix:
      typeof git.branchPrefix === 'string' && isBranchPrefix(git.branchPrefix)
        ? git.branchPrefix
        : defaults.branchPrefix,
    protectedBranches: Array.isArray(git.protectedBranches)
      ? git.protectedBranches
          .filter((p): p is string => typeof p === 'string' && isBranchPattern(p.trim()))
          .map((p) => p.trim())
          .slice(0, GIT_LIMITS.patterns)
      : defaults.protectedBranches,
    pullMode: oneOf(PULL_MODES, git.pullMode, defaults.pullMode),
    alwaysForcePush: git.alwaysForcePush === true,
    commitInstructions:
      typeof git.commitInstructions === 'string'
        ? git.commitInstructions
        : defaults.commitInstructions,
    autoFetch: AUTO_FETCH_MINUTES.find((m) => m === git.autoFetch) ?? defaults.autoFetch,
    mergeMethod: oneOf(MERGE_METHODS, git.mergeMethod, defaults.mergeMethod),
    draftPullRequests: git.draftPullRequests === true,
    prInstructions:
      typeof git.prInstructions === 'string' ? git.prInstructions : defaults.prInstructions,
    reviewPresentation: oneOf(
      REVIEW_PRESENTATIONS,
      git.reviewPresentation,
      defaults.reviewPresentation,
    ),
  };
}

function autoModeFrom(value: unknown): AutoModePreferences {
  const auto = isRecord(value) ? value : {};
  const list = (key: AutoModeList): readonly string[] => {
    const entries = auto[key];
    return Array.isArray(entries)
      ? entries.filter((e): e is string => typeof e === 'string' && e !== '$defaults')
      : [];
  };
  return {
    model: isModelReference(auto.model) ? auto.model : '',
    lists: {
      environment: list('environment'),
      allow: list('allow'),
      soft_deny: list('soft_deny'),
      hard_deny: list('hard_deny'),
    },
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
  /** T46: turning it on needs the main process's native confirmation and a reviewer. */
  | { readonly key: 'permissions.enableAutoMode'; readonly value: boolean }
  /** T46: `null` removes the reviewer. */
  | { readonly key: 'autoMode.model'; readonly value: string | null }
  | {
      readonly key: 'autoMode.list';
      readonly list: AutoModeList;
      readonly value: readonly string[];
    }
  /** `value` `null` restores the default key. */
  | { readonly key: 'keybinding'; readonly command: string; readonly value: string | null }
  /** ADR-0082: `manual` with an address, or back to the system's proxy. */
  | { readonly key: 'proxy'; readonly value: { readonly mode: ProxyMode; readonly url?: string } }
  /** ADR-0085: `''` removes the prefix. */
  | { readonly key: 'git.branchPrefix'; readonly value: string }
  /** `null` restores the default patterns. */
  | { readonly key: 'git.protectedBranches'; readonly value: readonly string[] | null }
  | { readonly key: 'git.pullMode'; readonly value: PullMode }
  /** Turning it on needs the main process's native confirmation. */
  | { readonly key: 'git.alwaysForcePush'; readonly value: boolean }
  /** `null` (or the default text) restores the default instructions. */
  | { readonly key: 'git.commitInstructions'; readonly value: string | null }
  | { readonly key: 'git.autoFetch'; readonly value: AutoFetchMinutes }
  | { readonly key: 'git.mergeMethod'; readonly value: MergeMethod }
  | { readonly key: 'git.draftPullRequests'; readonly value: boolean }
  /** `null` (or the default text) restores the default instructions. */
  | { readonly key: 'git.prInstructions'; readonly value: string | null }
  | { readonly key: 'git.reviewPresentation'; readonly value: ReviewPresentation };

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
    case 'permissions.enableAutoMode':
      return typeof value === 'boolean'
        ? { pointer: '/permissions/enableAutoMode', value }
        : undefined;
    case 'autoMode.model':
      if (value === null) return { pointer: '/autoMode/model', value: null };
      return isModelReference(value) ? { pointer: '/autoMode/model', value } : undefined;
    case 'autoMode.list': {
      const { list } = change;
      if (!(AUTO_MODE_LISTS as readonly unknown[]).includes(list) || !isPolicyList(value)) {
        return undefined;
      }
      return { pointer: `/autoMode/${String(list)}`, value: value.map((e) => e.trim()) };
    }
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
    case 'proxy': {
      if (!isRecord(value) || !(PROXY_MODES as readonly unknown[]).includes(value.mode)) {
        return undefined;
      }
      if (value.mode === 'auto') return { pointer: '/proxy/mode', value: 'auto' };
      const url = typeof value.url === 'string' ? value.url.trim() : '';
      return proxyUrlProblem(url) === undefined
        ? { pointer: '/proxy', value: { mode: 'manual', url } }
        : undefined;
    }
    case 'git.branchPrefix':
      if (typeof value !== 'string' || !isBranchPrefix(value)) return undefined;
      return { pointer: '/git/branchPrefix', value: value === '' ? null : value };
    case 'git.protectedBranches': {
      if (value === null) return { pointer: '/git/protectedBranches', value: null };
      if (!Array.isArray(value) || value.length > GIT_LIMITS.patterns) return undefined;
      const patterns = value.map((p: unknown) => (typeof p === 'string' ? p.trim() : ''));
      return patterns.every(isBranchPattern)
        ? { pointer: '/git/protectedBranches', value: [...new Set(patterns)] }
        : undefined;
    }
    case 'git.pullMode':
      return oneOf(PULL_MODES, value, 'config') === value
        ? { pointer: '/git/pullMode', value: value === 'config' ? null : value }
        : undefined;
    case 'git.alwaysForcePush':
      return typeof value === 'boolean'
        ? { pointer: '/git/alwaysForcePush', value: value ? true : null }
        : undefined;
    case 'git.commitInstructions':
      if (value === null) return { pointer: '/git/commitInstructions', value: null };
      return typeof value === 'string' && value.length <= GIT_LIMITS.instructions
        ? { pointer: '/git/commitInstructions', value: value.trim() === '' ? null : value }
        : undefined;
    case 'git.autoFetch':
      return AUTO_FETCH_MINUTES.some((m) => m === value)
        ? { pointer: '/git/autoFetch', value: value === 0 ? null : value }
        : undefined;
    case 'git.mergeMethod':
      return oneOf(MERGE_METHODS, value, 'squash') === value
        ? { pointer: '/git/mergeMethod', value: value === 'squash' ? null : value }
        : undefined;
    case 'git.draftPullRequests':
      return typeof value === 'boolean'
        ? { pointer: '/git/draftPullRequests', value: value ? true : null }
        : undefined;
    case 'git.prInstructions':
      if (value === null) return { pointer: '/git/prInstructions', value: null };
      return typeof value === 'string' && value.length <= GIT_LIMITS.instructions
        ? { pointer: '/git/prInstructions', value: value.trim() === '' ? null : value }
        : undefined;
    case 'git.reviewPresentation':
      return oneOf(REVIEW_PRESENTATIONS, value, 'inline') === value
        ? { pointer: '/git/reviewPresentation', value: value === 'inline' ? null : value }
        : undefined;
    default:
      return undefined;
  }
}
