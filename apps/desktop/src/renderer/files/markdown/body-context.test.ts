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
