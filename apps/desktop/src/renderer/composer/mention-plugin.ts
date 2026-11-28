// The `@` mention picker's state: open from an `@` typed outside an input method composition until
// the query ends (whitespace, the caret leaving it, a choice, or Esc). T19 replaces the fixed
// candidate list with Core's fuzzy file search.
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';

import { composerSchema, type MentionData } from './schema.js';

export interface MentionState {
  readonly active: boolean;
  /** Position of the `@`. */
  readonly from: number;
  /** Text typed after the `@`. */
  readonly query: string;
  /** Highlighted candidate, before wrapping to the candidate count. */
  readonly index: number;
}

export const CLOSED_MENTION: MentionState = { active: false, from: 0, query: '', index: 0 };

/** Longest query; longer input is not a mention any more. */
const MAX_QUERY = 64;

export const mentionKey = new PluginKey<MentionState>('mention');

type MentionMeta =
  | { readonly type: 'open'; readonly from: number }
  | { readonly type: 'close' }
  | { readonly type: 'move'; readonly delta: number };

function isMentionMeta(value: unknown): value is MentionMeta {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  switch (value.type) {
    case 'open':
      return 'from' in value && typeof value.from === 'number';
    case 'close':
      return true;
    case 'move':
      return 'delta' in value && typeof value.delta === 'number';
    default:
      return false;
  }
}

function follow(value: MentionState, tr: Transaction, state: EditorState): MentionState {
  const from = tr.mapping.map(value.from);
  const head = state.selection.head;
  if (
    head <= from ||
    state.doc.textBetween(from, Math.min(from + 1, state.doc.content.size)) !== '@'
  ) {
    return CLOSED_MENTION;
  }
  const query = state.doc.textBetween(from + 1, head);
  if (/\s/u.test(query) || query.length > MAX_QUERY) {
    return CLOSED_MENTION;
  }
  return { active: true, from, query, index: query === value.query ? value.index : 0 };
}

export function mentionPlugin(): Plugin<MentionState> {
  return new Plugin<MentionState>({
    key: mentionKey,
    state: {
      init: () => CLOSED_MENTION,
      apply(tr, value, _oldState, newState) {
        const meta: unknown = tr.getMeta(mentionKey);
        if (isMentionMeta(meta)) {
          switch (meta.type) {
            case 'open':
              return { active: true, from: meta.from, query: '', index: 0 };
            case 'close':
              return CLOSED_MENTION;
            case 'move':
              return { ...value, index: value.index + meta.delta };
          }
        }
        if (!value.active || (!tr.docChanged && !tr.selectionSet)) {
          return value;
        }
        return follow(value, tr, newState);
      },
    },
  });
}

/** A transaction that types `@` at `from`–`to` and opens the picker. */
export function openMention(state: EditorState, from: number, to: number): Transaction {
  return state.tr.insertText('@', from, to).setMeta(mentionKey, { type: 'open', from });
}

/** A transaction that moves the highlighted candidate. */
export function moveMention(state: EditorState, delta: number): Transaction {
  return state.tr.setMeta(mentionKey, { type: 'move', delta });
}

/** A transaction that closes the picker and leaves the text as typed. */
export function closeMention(state: EditorState): Transaction {
  return state.tr.setMeta(mentionKey, { type: 'close' });
}

/** A transaction that replaces `@query` with a chip for `mention` and a space. */
export function chooseMention(state: EditorState, mention: MentionData): Transaction {
  const current = mentionKey.getState(state) ?? CLOSED_MENTION;
  return state.tr
    .replaceWith(current.from, state.selection.head, [
      composerSchema.nodes.mention.create({
        id: mention.id,
        label: mention.label,
        path: mention.path,
      }),
      composerSchema.text(' '),
    ])
    .setMeta(mentionKey, { type: 'close' });
}

/** Candidates matching `query` (case-insensitive, on label or path). */
export function matchCandidates(
  candidates: readonly MentionData[],
  query: string,
): readonly MentionData[] {
  const needle = query.toLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.label.toLowerCase().includes(needle) ||
      candidate.path.toLowerCase().includes(needle),
  );
}
