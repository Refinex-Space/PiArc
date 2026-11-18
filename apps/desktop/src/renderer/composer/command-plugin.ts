// The `/` command palette's state: open from a `/` typed (outside an input method composition)
// into an empty composer, until the query ends (whitespace, a second line, the `/` deleted, a
// choice, or Esc). The query is what follows the `/`.
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';

export interface CommandState {
  readonly active: boolean;
  readonly query: string;
  /** Highlighted command, before wrapping to the command count. */
  readonly index: number;
}

export const CLOSED_COMMANDS: CommandState = { active: false, query: '', index: 0 };

export const commandKey = new PluginKey<CommandState>('commands');

type CommandMeta =
  { readonly type: 'open' | 'close' } | { readonly type: 'move'; readonly delta: number };

function isCommandMeta(value: unknown): value is CommandMeta {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  return (
    value.type === 'open' ||
    value.type === 'close' ||
    (value.type === 'move' && 'delta' in value && typeof value.delta === 'number')
  );
}

function follow(value: CommandState, state: EditorState): CommandState {
  const text = state.doc.textContent;
  if (state.doc.childCount !== 1 || !text.startsWith('/') || /\s/u.test(text)) {
    return CLOSED_COMMANDS;
  }
  const query = text.slice(1);
  return { active: true, query, index: query === value.query ? value.index : 0 };
}

export function commandPlugin(): Plugin<CommandState> {
  return new Plugin<CommandState>({
    key: commandKey,
    state: {
      init: () => CLOSED_COMMANDS,
      apply(tr, value, _oldState, newState) {
        const meta: unknown = tr.getMeta(commandKey);
        if (isCommandMeta(meta)) {
          switch (meta.type) {
            case 'open':
              return { active: true, query: '', index: 0 };
            case 'close':
              return CLOSED_COMMANDS;
            case 'move':
              return { ...value, index: value.index + meta.delta };
          }
        }
        if (!value.active || !tr.docChanged) {
          return value;
        }
        return follow(value, newState);
      },
    },
  });
}

/** A transaction that types `/` at `from`–`to` and opens the palette. */
export function openCommands(state: EditorState, from: number, to: number): Transaction {
  return state.tr.insertText('/', from, to).setMeta(commandKey, { type: 'open' });
}

export function moveCommands(state: EditorState, delta: number): Transaction {
  return state.tr.setMeta(commandKey, { type: 'move', delta });
}

export function closeCommands(state: EditorState): Transaction {
  return state.tr.setMeta(commandKey, { type: 'close' });
}

/** A command the palette lists (Core's `composerInfo().commands`). */
export interface PaletteCommand {
  readonly name: string;
  readonly description: string;
  readonly source: string;
  readonly action: string;
}

/**
 * Commands matching `query`, best first: the query's characters in order in the name
 * (case-insensitive), names starting with the query before the others.
 */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): readonly PaletteCommand[] {
  const needle = query.toLowerCase();
  const matches = (name: string): boolean => {
    let at = 0;
    for (const char of name.toLowerCase()) {
      if (char === needle[at]) {
        at += 1;
      }
    }
    return at === needle.length;
  };
  return commands
    .filter((command) => matches(command.name))
    .sort(
      (a, b) =>
        Number(!a.name.toLowerCase().startsWith(needle)) -
        Number(!b.name.toLowerCase().startsWith(needle)),
    );
}
