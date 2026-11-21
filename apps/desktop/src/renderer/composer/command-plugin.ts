// The `/` command palette's state: open from a `/` typed (outside an input method composition)
// into an empty composer, until the query ends (whitespace, a second line, the `/` deleted, a
// choice, or Esc). The query is what follows the `/`.
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';

import { fuzzyFilter } from '../../shared/fuzzy.js';

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

/** A command the palette lists: Core's merged list (`listCommands`, T37). */
export interface PaletteCommand {
  readonly name: string;
  /** Core's text; built-in commands are described by the client. */
  readonly description: string;
  /** Where it came from (`builtIn`, `projectClaude`, `user`, ...). */
  readonly source: string;
  /** `builtIn` runs in the client; the others are sent as `/name arguments`. */
  readonly kind: string;
  readonly argumentHint?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
}

/** Palette groups, in display order. */
export const SOURCE_ORDER: readonly string[] = [
  'builtIn',
  'projectPiarc',
  'projectClaude',
  'projectPi',
  'user',
  'userClaude',
  'userPi',
  'plugin',
  'mcp',
];

function rank(source: string): number {
  const at = SOURCE_ORDER.indexOf(source);
  return at === -1 ? SOURCE_ORDER.length : at;
}

/**
 * Commands matching `query` (the shared fuzzy matcher on the name, the aliases and the
 * description), grouped by source in `SOURCE_ORDER`, best first within a group.
 */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): readonly PaletteCommand[] {
  const ranked = fuzzyFilter(commands, query, (command) => [
    command.name,
    ...(command.aliases ?? []),
    command.description,
  ]);
  return ranked
    .map((command, order) => ({ command, order }))
    .sort((a, b) => rank(a.command.source) - rank(b.command.source) || a.order - b.order)
    .map((entry) => entry.command);
}
