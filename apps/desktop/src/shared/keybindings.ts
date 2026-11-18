// The keyboard shortcut registry (architecture section 8.5): command id → default key in `Mod`
// notation (`Mod` is ⌘ on macOS and Ctrl on Windows). The renderer matches key events against
// the effective bindings and runs the command; the main process shows the same keys as menu
// accelerators. User overrides live in the user's settings file (`keybindings`) and take
// effect at once in every window and in the menu.
//
// A task that adds a shortcut adds one entry to `COMMANDS` (with its message id for the label);
// everything else (settings page, menu accelerator, conflict check) follows from it.

import type { MessageId } from './i18n/index.js';

/** Where a command can run. */
export type CommandScope = 'app';

/** One registered command. */
export interface CommandSpec {
  /** Stable id: the key under `keybindings` in the settings file. */
  readonly id: string;
  /** Default key in `Mod` notation; `''` for a command without a default. */
  readonly defaultKey: string;
  /** Message id of its label (src/shared/i18n). */
  readonly label: MessageId;
  readonly scope: CommandScope;
}

/** Commands with shortcuts, in the order the settings page lists them. */
export const COMMANDS = [
  { id: 'session.new', defaultKey: 'Mod+N', label: 'command.session.new', scope: 'app' },
  { id: 'session.close', defaultKey: 'Mod+W', label: 'command.session.close', scope: 'app' },
  { id: 'session.next', defaultKey: 'Ctrl+Tab', label: 'command.session.next', scope: 'app' },
  {
    id: 'help.shortcuts',
    defaultKey: 'Mod+/',
    label: 'command.help.shortcuts',
    scope: 'app',
  },
  { id: 'app.settings', defaultKey: 'Mod+,', label: 'command.app.settings', scope: 'app' },
] as const satisfies readonly CommandSpec[];

export type CommandId = (typeof COMMANDS)[number]['id'];

/** The message id of a command's label. */
export function commandLabel(id: CommandId): MessageId {
  return COMMANDS.find((command) => command.id === id)?.label ?? 'command.session.new';
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string' && COMMANDS.some((command) => command.id === value);
}

/** Modifiers in their canonical order. `Mod` is the platform's command key. */
const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Keys a binding may end with (besides A–Z and 0–9). */
const NAMED_KEYS = [
  'Tab',
  'Enter',
  'Escape',
  'Backspace',
  'Delete',
  'Space',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${String(i + 1)}`),
] as const;

/** Punctuation keys, by `KeyboardEvent.code`. */
const PUNCTUATION: Readonly<Record<string, string>> = {
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
};

const CODE_TO_KEY: Readonly<Record<string, string>> = {
  ...PUNCTUATION,
  Tab: 'Tab',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** A parsed key: modifiers and the final key. */
export interface Chord {
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

function isKeyName(key: string): boolean {
  return (
    /^[A-Z0-9]$/.test(key) ||
    (NAMED_KEYS as readonly string[]).includes(key) ||
    Object.values(PUNCTUATION).includes(key)
  );
}

/**
 * Parses `Mod+Shift+N` (modifiers in any order, case-insensitive) into a chord; `undefined`
 * for anything else.
 */
export function parseKey(text: string): Chord | undefined {
  const parts = text.split('+');
  // `Mod++` is not a key; `+` itself is spelled `=` with Shift.
  if (parts.some((part) => part === '') || parts.length === 0) {
    return undefined;
  }
  const key = parts[parts.length - 1] ?? '';
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key;
  if (!isKeyName(normalizedKey)) {
    return undefined;
  }
  const modifiers = new Set<Modifier>();
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS.find((m) => m.toLowerCase() === part.toLowerCase());
    if (modifier === undefined || modifiers.has(modifier)) {
      return undefined;
    }
    modifiers.add(modifier);
  }
  return { modifiers: MODIFIERS.filter((m) => modifiers.has(m)), key: normalizedKey };
}

/** The canonical text of a chord (`Mod+Shift+N`). */
export function formatKey(chord: Chord): string {
  return [...chord.modifiers, chord.key].join('+');
}

/** Platforms with their own modifier mapping. */
export type KeyPlatform = 'mac' | 'other';

export function keyPlatformOf(platform: string): KeyPlatform {
  return platform === 'darwin' ? 'mac' : 'other';
}

/**
 * The physical keys a chord means on `platform` (`Mod` is ⌘ on macOS, Ctrl elsewhere): two
 * bindings conflict when these are equal.
 */
export function physicalKey(chord: Chord, platform: KeyPlatform): string {
  const held = new Set<string>();
  for (const modifier of chord.modifiers) {
    held.add(modifier === 'Mod' ? (platform === 'mac' ? 'Meta' : 'Ctrl') : modifier);
  }
  return [...['Meta', 'Ctrl', 'Alt', 'Shift'].filter((m) => held.has(m)), chord.key].join('+');
}

/** The part of a `KeyboardEvent` the matcher reads. */
export interface KeyEventLike {
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * The chord a key event produced, from `code` (so layouts and Shift do not change it), or
 * `undefined` for a lone modifier or an unsupported key.
 */
export function chordOfEvent(event: KeyEventLike, platform: KeyPlatform): Chord | undefined {
  const { code } = event;
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3);
  } else if (/^Digit[0-9]$/.test(code)) {
    key = code.slice(5);
  } else if (/^F([1-9]|1[0-2])$/.test(code)) {
    key = code;
  } else {
    key = CODE_TO_KEY[code];
  }
  if (key === undefined) {
    return undefined;
  }
  const modifiers: Modifier[] = [];
  if (platform === 'mac') {
    if (event.metaKey) modifiers.push('Mod');
    if (event.ctrlKey) modifiers.push('Ctrl');
  } else if (event.ctrlKey) {
    modifiers.push('Mod');
  }
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  return { modifiers, key };
}

/** Whether a chord may be a shortcut: it needs Mod, Ctrl or Alt, unless it is a function key. */
export function isAssignable(chord: Chord): boolean {
  return (
    /^F([1-9]|1[0-2])$/.test(chord.key) ||
    chord.modifiers.some((m) => m === 'Mod' || m === 'Ctrl' || m === 'Alt')
  );
}

/** The effective key of every command: its override, else its default (`''` = unbound). */
export function effectiveBindings(
  overrides: Readonly<Record<string, string>>,
): Readonly<Record<CommandId, string>> {
  const result: Partial<Record<CommandId, string>> = {};
  for (const command of COMMANDS) {
    const override = overrides[command.id];
    result[command.id] =
      override !== undefined && (override === '' || parseKey(override) !== undefined)
        ? override
        : command.defaultKey;
  }
  return result as Record<CommandId, string>;
}

/** The command a key event triggers, if any. */
export function commandForEvent(
  event: KeyEventLike,
  bindings: Readonly<Record<CommandId, string>>,
  platform: KeyPlatform,
): CommandId | undefined {
  const chord = chordOfEvent(event, platform);
  if (chord === undefined) {
    return undefined;
  }
  const pressed = physicalKey(chord, platform);
  return COMMANDS.find((command) => {
    const bound = parseKey(bindings[command.id]);
    return bound !== undefined && physicalKey(bound, platform) === pressed;
  })?.id;
}

/** The command that already uses `key` on `platform`, other than `except`. */
export function conflictFor(
  key: string,
  except: CommandId,
  bindings: Readonly<Record<CommandId, string>>,
  platform: KeyPlatform,
): CommandId | undefined {
  const chord = parseKey(key);
  if (chord === undefined) {
    return undefined;
  }
  const wanted = physicalKey(chord, platform);
  return COMMANDS.find((command) => {
    if (command.id === except) {
      return false;
    }
    const bound = parseKey(bindings[command.id]);
    return bound !== undefined && physicalKey(bound, platform) === wanted;
  })?.id;
}

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  Enter: 'Return',
  Escape: 'Esc',
};

/** The Electron accelerator of a key (`Mod+N` → `CommandOrControl+N`). */
export function toAccelerator(key: string): string | undefined {
  const chord = parseKey(key);
  if (chord === undefined) {
    return undefined;
  }
  const names: Record<Modifier, string> = {
    Mod: 'CommandOrControl',
    Ctrl: 'Control',
    Alt: 'Alt',
    Shift: 'Shift',
  };
  return [...chord.modifiers.map((m) => names[m]), ACCELERATOR_KEYS[chord.key] ?? chord.key].join(
    '+',
  );
}

const MAC_SYMBOLS: Readonly<Record<Modifier, string>> = {
  Mod: '⌘',
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
};

const MAC_KEYS: Readonly<Record<string, string>> = {
  Enter: '↩',
  Escape: '⎋',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
};

/** How a key is shown to the user on `platform` (`⌘N`, `Ctrl+N`). */
export function displayKey(key: string, platform: KeyPlatform): string {
  const chord = parseKey(key);
  if (chord === undefined) {
    return '';
  }
  if (platform === 'mac') {
    const order: Modifier[] = ['Ctrl', 'Alt', 'Shift', 'Mod'];
    const mods = order.filter((m) => chord.modifiers.includes(m)).map((m) => MAC_SYMBOLS[m]);
    return [...mods, MAC_KEYS[chord.key] ?? chord.key].join('');
  }
  return [...chord.modifiers.map((m) => (m === 'Mod' ? 'Ctrl' : m)), chord.key].join('+');
}
