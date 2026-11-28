// The composer's key semantics (architecture section 8.2): idle, Enter sends and Shift+Enter
// adds a line; while the agent runs, Enter steers, Mod+Enter queues and Esc stops. Key names
// follow prosemirror-keymap, which maps `Mod` to ⌘ on macOS and Ctrl elsewhere.

export type ComposerKey = 'Enter' | 'Shift-Enter' | 'Mod-Enter' | 'Escape';

export type ComposerIntent = 'send' | 'steer' | 'queue' | 'stop' | 'newline';

export const COMPOSER_KEYS: readonly ComposerKey[] = [
  'Enter',
  'Shift-Enter',
  'Mod-Enter',
  'Escape',
];

/** What `key` does in the given state, or `null` when it does nothing special. */
export function intentFor(key: ComposerKey, running: boolean): ComposerIntent | null {
  switch (key) {
    case 'Enter':
      return running ? 'steer' : 'send';
    case 'Shift-Enter':
      return 'newline';
    case 'Mod-Enter':
      return running ? 'queue' : 'send';
    case 'Escape':
      return running ? 'stop' : null;
  }
}
