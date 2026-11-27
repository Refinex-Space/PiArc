// The dictation plugin on a real EditorState and EditorView (addendum 3.3, V-3.1–V-3.9).
// @vitest-environment happy-dom
import { history, undo } from 'prosemirror-history';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it } from 'vitest';

import { composerSchema } from '../schema.js';
import { serializeDoc } from '../serialize.js';
import {
  beginTransaction,
  cancelTransaction,
  closeGroupTransaction,
  commitTransaction,
  dictationPlugin,
  dictationState,
  endTransaction,
  partialTransaction,
} from './plugin.js';

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function editor(text: string, cursor?: number): EditorView {
  const doc = composerSchema.node('doc', null, [
    composerSchema.node('paragraph', null, text === '' ? [] : [composerSchema.text(text)]),
  ]);
  let state = EditorState.create({
    schema: composerSchema,
    doc,
    plugins: [dictationPlugin(), history()],
  });
  if (cursor !== undefined) {
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursor)));
  }
  const view = new EditorView(document.createElement('div'), { state });
  views.push(view);
  return view;
}

function text(view: EditorView): string {
  return view.state.doc.textContent;
}

function commit(
  view: EditorView,
  segment: number,
  revision: number,
  stage: 'provisional' | 'final',
  value: string,
) {
  const tr = commitTransaction(view.state, segment, revision, stage, value);
  if (tr !== undefined) {
    view.dispatch(tr);
    view.dispatch(closeGroupTransaction(view.state));
  }
}

function typeAt(view: EditorView, at: number, value: string) {
  view.dispatch(view.state.tr.insertText(value, at));
}

describe('dictation plugin', () => {
  it('shows a partial without changing the document', () => {
    const view = editor('前缀 ', 4);
    const before = view.state.doc;
    view.dispatch(beginTransaction(view.state));
    view.dispatch(partialTransaction(view.state, 0, 1, '你好'));
    expect(view.state.doc.eq(before)).toBe(true);
    expect(serializeDoc(view.state.doc).text).toBe('前缀 ');
    expect(view.dom.querySelector('.dictation-partial')?.textContent).toBe('你好');
    view.dispatch(partialTransaction(view.state, 0, 2, '你好世界'));
    expect(view.dom.querySelectorAll('.dictation-partial')).toHaveLength(1);
    expect(view.dom.querySelector('.dictation-partial')?.textContent).toBe('你好世界');
  });

  it('inserts at the selection end without replacing the selection', () => {
    const view = editor('keep this text', 1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 5)));
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'final', ' new');
    expect(text(view)).toBe('keep new this text');
  });

  it('commits segments in order and clears the partial', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    view.dispatch(partialTransaction(view.state, 0, 1, '第一'));
    commit(view, 0, 2, 'final', '第一段。');
    expect(dictationState(view.state).partial).toBeNull();
    commit(view, 1, 1, 'final', '第二段。');
    expect(text(view)).toBe('第一段。第二段。');
  });

  it('replaces a provisional segment only while untouched and with a newer revision', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'provisional', 'spring boot');
    commit(view, 0, 2, 'final', 'Spring Boot');
    expect(text(view)).toBe('Spring Boot');
    commit(view, 0, 1, 'final', 'stale');
    expect(text(view)).toBe('Spring Boot');
  });

  it('never writes into a segment the user edited', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'provisional', 'abc');
    typeAt(view, 2, 'X');
    commit(view, 0, 2, 'final', 'refined');
    expect(text(view)).toBe('aXbc');
    expect(dictationState(view.state).segments[0]?.touched).toBe(true);
  });

  it('follows edits before the segment', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'provisional', 'world');
    typeAt(view, 1, 'hello ');
    commit(view, 0, 2, 'final', 'World');
    expect(text(view)).toBe('hello World');
  });

  it('puts the next segment after text the user typed at the anchor', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'final', 'one ');
    typeAt(view, 5, 'typed ');
    commit(view, 1, 1, 'final', 'two');
    expect(text(view)).toBe('one typed two');
  });

  it('keeps the selection of a user who moved away', () => {
    const view = editor('start end', 1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7)));
    view.dispatch(beginTransaction(view.state));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    commit(view, 0, 1, 'final', 'X');
    expect(text(view)).toBe('start Xend');
    expect(view.state.selection.from).toBe(1);
  });

  it('treats recognized @ and / as plain text', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'final', '/clear @file');
    const serialized = serializeDoc(view.state.doc);
    expect(serialized.text).toBe('/clear @file');
    expect(serialized.mentions).toHaveLength(0);
  });

  it('handles emoji and surrogate pairs in ranges', () => {
    const view = editor('😀', 3);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'provisional', '好👍');
    commit(view, 0, 2, 'final', '好的👍');
    expect(text(view)).toBe('😀好的👍');
  });

  it('cancel removes only owned text, in one undo step', () => {
    const view = editor('draft ', 7);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'final', 'dictated ');
    commit(view, 1, 1, 'final', 'more');
    typeAt(view, 8, '!');
    const { tr, kept } = cancelTransaction(view.state);
    view.dispatch(tr);
    expect(kept).toBe(1);
    expect(text(view)).toBe('draft d!ictated ');
    undo(view.state, view.dispatch);
    expect(text(view)).toBe('draft d!ictated more');
  });

  it('each final is its own undo step, apart from typing', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'final', 'spoken');
    typeAt(view, 7, ' typed');
    undo(view.state, view.dispatch);
    expect(text(view)).toBe('spoken');
    undo(view.state, view.dispatch);
    expect(text(view)).toBe('');
  });

  it('partials never enter the history', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    view.dispatch(partialTransaction(view.state, 0, 1, 'x'));
    view.dispatch(partialTransaction(view.state, 0, 2, 'xy'));
    expect(undo(view.state)).toBe(false);
  });

  it('a later result for an undone segment is not written back', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'provisional', 'gone');
    undo(view.state, view.dispatch);
    commit(view, 0, 2, 'final', 'Gone');
    expect(text(view)).toBe('');
  });

  it('a replaced document stops tracking safely', () => {
    const view = editor('', 1);
    view.dispatch(beginTransaction(view.state));
    commit(view, 0, 1, 'provisional', 'abc');
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, composerSchema.node('paragraph')),
    );
    commit(view, 0, 2, 'final', 'abd');
    expect(text(view)).toBe('');
    view.dispatch(endTransaction(view.state));
    expect(dictationState(view.state).active).toBe(false);
  });
});
