// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { expect, it, vi } from 'vitest';
import { Translator } from '../../../shared/i18n/index.js';
import { markdownSupport } from './language.js';
import { editorBodyActions } from './body-context.js';
const t = new Translator('en');
it('uses the original right-click selection for formatting and prevents edits when the document changed while a menu was open', () => {
  const view = new EditorView({
    state: EditorState.create({ doc: 'alpha beta', extensions: [markdownSupport(), history()] }),
    parent: document.createElement('div'),
  });
  try {
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    const open = () =>
      editorBodyActions(view, 2, {
        t: (k, v) => t.t(k, v),
        copy: vi.fn(),
        paste: vi.fn(),
        attach: vi.fn(),
        comment: vi.fn(),
        openLink: vi.fn(),
        report: vi.fn(),
      });
    const format = open()
      .find((i) => i.id === 'md-format')
      ?.submenu?.find((i) => i.id === 'md-bold');
    expect(format).toBeDefined();
    view.dispatch({ selection: { anchor: 8 } });
    format?.run?.();
    expect(view.state.doc.toString()).toBe('**alpha** beta');
    expect(undo(view)).toBe(true);
    const stale = open()
      .find((i) => i.id === 'md-format')
      ?.submenu?.find((i) => i.id === 'md-italic');
    view.dispatch({ changes: { from: 0, insert: 'changed ' } });
    stale?.run?.();
    expect(view.state.doc.toString()).toBe('changed alpha beta');
  } finally {
    view.destroy();
  }
});

it('offers source table operations at the clicked cell, keeps undo, and disables invalid row or column operations', () => {
  const text = '| Name | Date |\n| --- | --- |\n| Tea | Monday |\n| Coffee | Friday |';
  const view = new EditorView({
    parent: document.createElement('div'),
    state: EditorState.create({ doc: text, extensions: [markdownSupport(), history()] }),
  });
  const options = {
    t: (k: Parameters<typeof t.t>[0], v?: Parameters<typeof t.t>[1]) => t.t(k, v),
    copy: vi.fn(),
    paste: vi.fn(),
    attach: vi.fn(),
    comment: vi.fn(),
    openLink: vi.fn(),
    report: vi.fn(),
  };
  const cell = (offset: number) =>
    editorBodyActions(view, offset, options).find((item) => item.id === 'md-table-actions')
      ?.submenu;
  try {
    const heading = cell(text.indexOf('Name'));
    expect(heading?.find((action) => action.id === 'md-table-deleteRow')?.disabled).toBe(true);
    expect(heading?.find((action) => action.id === 'md-table-moveLeft')?.disabled).toBe(true);
    const target = cell(text.indexOf('Friday'));
    expect(target?.find((action) => action.id === 'md-table-moveRight')?.disabled).toBe(true);
    const add = target?.find((action) => action.id === 'md-table-addRow');
    expect(add?.disabled).not.toBe(true);
    add?.run?.();
    expect(view.state.doc.lines).toBe(5);
    expect(view.state.doc.line(4).text).toContain('Friday');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(text);
    view.setState(
      EditorState.create({
        doc: text,
        extensions: [markdownSupport(), EditorState.readOnly.of(true)],
      }),
    );
    expect(cell(text.indexOf('Friday'))).toBeUndefined();
  } finally {
    view.destroy();
  }
});
