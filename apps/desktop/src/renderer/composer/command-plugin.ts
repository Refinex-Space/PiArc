// The `/` command palette's state (ADR-0080): open from a `/` typed (outside an input method
// composition) into an empty composer, or from a name character typed right after a `/` that
// starts a word anywhere in the text; until the query ends (whitespace, the cursor leaving it,
// the `/` deleted, a choice, or Esc). The query is what follows the `/`.
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';

import { fuzzyFilter } from '../../shared/fuzzy.js';

export interface CommandState {
  readonly active: boolean;
  readonly query: string;
  /** Highlighted command, before wrapping to the command count. */
  readonly index: number;
  /** The document position of the `/`. */
  readonly from: number;
  /** The `/` starts the message: built-in commands are offered only there. */
  readonly atStart: boolean;
}

export const CLOSED_COMMANDS: CommandState = {
  active: false,
  query: '',
  index: 0,
  from: 0,
  atStart: true,
};

export const commandKey = new PluginKey<CommandState>('commands');

type CommandMeta =
  | { readonly type: 'open'; readonly from: number }
  | { readonly type: 'close' }
  | { readonly type: 'move'; readonly delta: number };

function isCommandMeta(value: unknown): value is CommandMeta {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  return (
    (value.type === 'open' && 'from' in value && typeof value.from === 'number') ||
    value.type === 'close' ||
    (value.type === 'move' && 'delta' in value && typeof value.delta === 'number')
  );
}

/** The longest query the palette follows. */
const MAX_QUERY = 50;

/** The palette for a `/` at `from`, or closed when the text there no longer starts a query. */
function opened(state: EditorState, from: number, index = 0, previous = ''): CommandState {
  const { selection, doc } = state;
  if (!selection.empty || from < 1 || from >= doc.content.size) return CLOSED_COMMANDS;
  const $slash = doc.resolve(from);
  const cursor = selection.from;
  if (cursor <= from || cursor > $slash.end() || doc.textBetween(from, from + 1) !== '/') {
    return CLOSED_COMMANDS;
  }
  const query = doc.textBetween(from + 1, cursor, '\n', '\uFFFC');
  if (/[\s\uFFFC]/u.test(query) || query.length > MAX_QUERY) return CLOSED_COMMANDS;
  return {
    active: true,
    query,
    index: query === previous ? index : 0,
    from,
    atStart: from === 1,
  };
}

function follow(value: CommandState, state: EditorState, tr: Transaction): CommandState {
  return opened(state, tr.mapping.map(value.from, -1), value.index, value.query);
}

/** Where a `/` starts a word before `at`: the text run's start or a space before it. */
export function slashBefore(state: EditorState, at: number): number | undefined {
  const $at = state.doc.resolve(at);
  const before = $at.parent.textBetween(0, $at.parentOffset, undefined, '\uFFFC');
  const match = /(?:^|[\s\uFFFC])\/([A-Za-z0-9_][\w:.-]*)?$/u.exec(before);
  if (match === null) return undefined;
  return at - (match[1]?.length ?? 0) - 1;
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
              return opened(newState, meta.from);
            case 'close':
              return CLOSED_COMMANDS;
            case 'move':
              return { ...value, index: value.index + meta.delta };
          }
        }
        if (!value.active || (!tr.docChanged && !tr.selectionSet)) {
          return value;
        }
        return follow(value, newState, tr);
      },
    },
  });
}

/** A transaction that types `/` at `from`–`to` and opens the palette. */
export function openCommands(state: EditorState, from: number, to: number): Transaction {
  return state.tr.insertText('/', from, to).setMeta(commandKey, { type: 'open', from });
}

/**
 * A transaction that types `text` (a name character) at `from`–`to` after the `/` at
 * `slash`, opening the palette there: a command in the middle of the text (ADR-0080).
 */
export function continueCommand(
  state: EditorState,
  slash: number,
  from: number,
  to: number,
  text: string,
): Transaction {
  return state.tr.insertText(text, from, to).setMeta(commandKey, { type: 'open', from: slash });
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
