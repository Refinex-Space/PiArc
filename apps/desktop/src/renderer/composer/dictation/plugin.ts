// The dictation part of the composer's editor state (voice dictation addendum 3.3, 4.9).
// Recognized text that is still a running hypothesis is a widget decoration at the anchor and
// never part of the document; a segment that ended is inserted as ordinary text and tracked as
// an owned range. Ranges follow every edit through the transaction's mapping; an edit that
// touches a range hands it to the user, and dictation never writes into it again. Only the
// transactions built here (`DictationAction`) change the plugin's state; everything else maps.
import { closeHistory } from 'prosemirror-history';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

/** A segment of dictated text in the document. */
export interface OwnedSegment {
  readonly segment: number;
  readonly from: number;
  readonly to: number;
  readonly revision: number;
  /** `provisional`: refinement may still replace it; `final`: settled. */
  readonly stage: 'provisional' | 'final';
  /** The user edited inside it: dictation leaves it alone from now on. */
  readonly touched: boolean;
}

export interface DictationPluginState {
  readonly active: boolean;
  /** Where the next segment and the running hypothesis go. */
  readonly anchor: number;
  readonly segments: readonly OwnedSegment[];
  readonly partial: {
    readonly segment: number;
    readonly revision: number;
    readonly text: string;
  } | null;
}

export type DictationAction =
  | { readonly type: 'begin'; readonly at: number }
  | {
      readonly type: 'partial';
      readonly segment: number;
      readonly revision: number;
      readonly text: string;
    }
  | {
      readonly type: 'commit';
      readonly segment: number;
      readonly revision: number;
      readonly stage: 'provisional' | 'final';
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly type: 'stage';
      readonly segment: number;
      readonly revision: number;
      readonly stage: 'provisional' | 'final';
    }
  | { readonly type: 'end' };

export const dictationKey = new PluginKey<DictationPluginState>('dictation');

const IDLE: DictationPluginState = { active: false, anchor: 0, segments: [], partial: null };

/** Whether `tr` changed the document inside `[from, to)` (not only at its edges). */
function touches(tr: Transaction, from: number, to: number): boolean {
  let hit = false;
  let start = from;
  let end = to;
  for (const step of tr.steps) {
    const map = step.getMap();
    map.forEach((oldStart, oldEnd) => {
      const inside = oldStart < end && oldEnd > start;
      const insertedWithin = oldStart === oldEnd && oldStart > start && oldStart < end;
      if (inside || insertedWithin) hit = true;
    });
    start = map.map(start, 1);
    end = map.map(end, -1);
  }
  return hit;
}

function reduce(state: DictationPluginState, tr: Transaction): DictationPluginState {
  const action = tr.getMeta(dictationKey) as DictationAction | undefined;
  let next = state;
  if (tr.docChanged && action?.type !== 'commit') {
    // A user edit (or a document replaced from outside): map the anchor and ranges, and hand
    // over the ranges it touched. Text typed at the anchor stays before the next segment.
    next = {
      ...next,
      anchor: tr.mapping.map(next.anchor, 1),
      segments: next.segments.map((s) => {
        const from = tr.mapping.map(s.from, 1);
        const to = Math.max(from, tr.mapping.map(s.to, -1));
        return { ...s, from, to, touched: s.touched || touches(tr, s.from, s.to) };
      }),
      // A range the user emptied (deleted, undone) stays, touched: its later results are
      // not written back.
    };
  }
  if (action === undefined) return next;
  switch (action.type) {
    case 'begin':
      return { active: true, anchor: action.at, segments: [], partial: null };
    case 'partial':
      return action.text === ''
        ? { ...next, partial: null }
        : {
            ...next,
            partial: { segment: action.segment, revision: action.revision, text: action.text },
          };
    case 'commit': {
      // The commit transaction inserted or replaced text itself: map the other ranges.
      const others = next.segments
        .filter((s) => s.segment !== action.segment)
        .map((s) => ({
          ...s,
          from: tr.mapping.map(s.from, s.from >= action.to ? 1 : -1),
          to: tr.mapping.map(s.to, -1),
        }));
      const segments = [
        ...others,
        {
          segment: action.segment,
          from: action.from,
          to: action.to,
          revision: action.revision,
          stage: action.stage,
          touched: false,
        },
      ].sort((a, b) => a.from - b.from);
      const anchor = Math.max(tr.mapping.map(next.anchor, 1), action.to);
      return {
        ...next,
        anchor,
        segments,
        partial: next.partial?.segment === action.segment ? null : next.partial,
      };
    }
    case 'stage':
      return {
        ...next,
        segments: next.segments.map((s) =>
          s.segment === action.segment
            ? { ...s, stage: action.stage, revision: action.revision }
            : s,
        ),
      };
    case 'end':
      return IDLE;
  }
}

function partialWidget(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'dictation-partial';
  span.setAttribute('data-testid', 'dictation-partial');
  span.setAttribute('aria-hidden', 'true');
  span.textContent = text;
  return span;
}

/** The plugin: state, the partial widget and the provisional underline. */
export function dictationPlugin(): Plugin<DictationPluginState> {
  return new Plugin<DictationPluginState>({
    key: dictationKey,
    state: {
      init: () => IDLE,
      apply: (tr, state) => reduce(state, tr),
    },
    props: {
      decorations(state) {
        const dictation = dictationKey.getState(state);
        if (!dictation?.active) return null;
        const decorations: Decoration[] = [];
        for (const segment of dictation.segments) {
          if (segment.stage === 'provisional' && !segment.touched && segment.to > segment.from) {
            decorations.push(
              Decoration.inline(segment.from, segment.to, { class: 'dictation-provisional' }),
            );
          }
        }
        if (dictation.partial !== null) {
          const anchor = Math.min(dictation.anchor, state.doc.content.size);
          decorations.push(
            Decoration.widget(anchor, () => partialWidget(dictation.partial?.text ?? ''), {
              side: -1,
              key: `dictation-partial:${dictation.partial.text}`,
              ignoreSelection: true,
            }),
          );
        }
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

/** The plugin state of `state` (idle when the plugin is missing). */
export function dictationState(state: EditorState): DictationPluginState {
  return dictationKey.getState(state) ?? IDLE;
}

/**
 * Puts the user's selection back after an ASR change (V-3.6): `insertText` collapses a
 * selection that ends where the text goes. A selection keeps exactly the text it covered (its
 * start maps after, its end before inserted text); a cursor maps as typing would move it.
 */
function keepSelection(state: EditorState, tr: Transaction): Transaction {
  const { selection } = state;
  if (!(selection instanceof TextSelection)) return tr;
  if (selection.empty) {
    return tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(selection.head)));
  }
  const from = tr.mapping.map(selection.from, 1);
  const to = Math.max(from, tr.mapping.map(selection.to, -1));
  const backward = selection.head < selection.anchor;
  return tr.setSelection(
    backward ? TextSelection.create(tr.doc, to, from) : TextSelection.create(tr.doc, from, to),
  );
}

/** A transaction that starts tracking at the selection's end (never over selected text). */
export function beginTransaction(state: EditorState): Transaction {
  return state.tr
    .setMeta(dictationKey, { type: 'begin', at: state.selection.to } satisfies DictationAction)
    .setMeta('addToHistory', false);
}

/** A transaction that shows `text` as the running hypothesis (no document change). */
export function partialTransaction(
  state: EditorState,
  segment: number,
  revision: number,
  text: string,
): Transaction {
  return state.tr
    .setMeta(dictationKey, { type: 'partial', segment, revision, text } satisfies DictationAction)
    .setMeta('addToHistory', false);
}

/**
 * The transaction that puts a segment's text into the document: a new segment at the anchor,
 * or the replacement of an owned, untouched segment. `undefined` when there is nothing to do
 * (same text, or the user took the segment over). Each change is its own undo step.
 */
export function commitTransaction(
  state: EditorState,
  segment: number,
  revision: number,
  stage: 'provisional' | 'final',
  text: string,
): Transaction | undefined {
  const dictation = dictationState(state);
  if (!dictation.active) return undefined;
  const existing = dictation.segments.find((s) => s.segment === segment);
  if (existing !== undefined) {
    if (existing.touched || revision <= existing.revision) return undefined;
    const current = state.doc.textBetween(existing.from, existing.to, '\n');
    if (current === text) {
      return state.tr
        .setMeta(dictationKey, {
          type: 'stage',
          segment,
          revision,
          stage,
        } satisfies DictationAction)
        .setMeta('addToHistory', false);
    }
    const tr = keepSelection(state, state.tr.insertText(text, existing.from, existing.to));
    return closeHistory(tr).setMeta(dictationKey, {
      type: 'commit',
      segment,
      revision,
      stage,
      from: existing.from,
      to: existing.from + text.length,
    } satisfies DictationAction);
  }
  if (text === '') return undefined;
  const at = Math.min(dictation.anchor, state.doc.content.size);
  // Inside an empty paragraph or after text: insertText keeps the paragraph structure.
  const tr = keepSelection(state, state.tr.insertText(text, at));
  return closeHistory(tr).setMeta(dictationKey, {
    type: 'commit',
    segment,
    revision,
    stage,
    from: at,
    to: at + text.length,
  } satisfies DictationAction);
}

/**
 * The transaction that removes what dictation still owns (cancel): untouched segments and the
 * hypothesis. One undo step, so Mod+Z brings the text back. Touched segments stay.
 */
export function cancelTransaction(state: EditorState): { tr: Transaction; kept: number } {
  const dictation = dictationState(state);
  let tr = state.tr;
  const owned = dictation.segments.filter((s) => !s.touched).sort((a, b) => b.from - a.from);
  for (const segment of owned) {
    tr = tr.delete(segment.from, segment.to);
  }
  tr = closeHistory(tr).setMeta(dictationKey, { type: 'end' } satisfies DictationAction);
  return { tr, kept: dictation.segments.length - owned.length };
}

/** The transaction that stops tracking (stop, send, unmount); the document stays. */
export function endTransaction(state: EditorState): Transaction {
  return state.tr
    .setMeta(dictationKey, { type: 'end' } satisfies DictationAction)
    .setMeta('addToHistory', false);
}

/** An empty transaction that closes the undo group, so typing after dictation is its own step. */
export function closeGroupTransaction(state: EditorState): Transaction {
  return closeHistory(state.tr).setMeta('addToHistory', false);
}
