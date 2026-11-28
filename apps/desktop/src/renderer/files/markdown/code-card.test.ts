// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { Translator } from '../../../shared/i18n/index.js';
import { liveMode, liveExtensions } from './live-preview.js';
import { markdownSupport } from './language.js';
import { widgetHost } from './widget-host.js';

function open(doc: string, live = true, readonly = false) {
  const parent = document.createElement('div');
  const t = new Translator('en');
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdownSupport(),
        history(),
        liveMode.of(live),
        ...liveExtensions,
        EditorState.readOnly.of(readonly),
        EditorView.editable.of(!readonly),
        widgetHost.of({
          t: (k, v) => t.t(k, v),
          mount: (el, content) => {
            el.dataset.kind = content.kind;
            el.textContent = content.source;
          },
          unmount: () => undefined,
        }),
      ],
    }),
  });
}
const combobox = (v: EditorView) =>
  v.dom.querySelector<HTMLInputElement>('.md-code-footer [role=combobox]');
const press = (v: EditorView, key: string) =>
  runScopeHandlers(v, new KeyboardEvent('keydown', { key }), 'editor');
it('replaces just the two fence lines with a continuous live card, leaving source view and unfinished or bodyless fences literal', () => {
  const source = '~~~js\nconst 語 = 1;\n~~~~';
  for (const [text, live, visible] of [
    [source, true, 1],
    [source, false, 0],
    ['~~~js\n~~~', true, 0],
    ['~~~js\n未閉じ', true, 0],
  ] as const) {
    const view = open(text, live);
    try {
      expect(view.dom.querySelectorAll('.md-code-top')).toHaveLength(visible);
      expect(view.dom.querySelectorAll('.md-code-footer')).toHaveLength(visible);
      if (visible) {
        expect(view.dom.querySelectorAll('.cm-line.md-code-block')).toHaveLength(1);
        expect(view.contentDOM.textContent).not.toContain('~~~');
        expect(combobox(view)?.value).toBe('js');
      } else expect(view.contentDOM.textContent).toContain('~~~');
      expect(view.state.doc.toString()).toBe(text);
    } finally {
      view.destroy();
    }
  }
});
it('a read-only card exposes the label and an exact plain-text copy, with success and failure feedback', async () => {
  const text = '~~~text\n\t值 = 3;\n\n~~~';
  const view = open(text, true, true);
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  try {
    expect(combobox(view)).toBeNull();
    expect(view.dom.querySelector('.md-code-label')?.textContent).toBe('text');
    const button = view.dom.querySelector<HTMLButtonElement>('.md-code-copy');
    if (!button) throw Error('Expected copy button');
    button.click();
    await vi.waitFor(() => {
      expect(button.getAttribute('aria-label')).toBe('Copied');
    });
    expect(copy).toHaveBeenCalledWith('\t值 = 3;\n');
    copy.mockRejectedValue(new Error('denied'));
    button.click();
    await vi.waitFor(() => {
      expect(view.dom.querySelector('[role=status]')?.textContent).toContain('denied');
    });
    expect(button.getAttribute('aria-label')).toBe('Copy code block');
    expect(view.state.doc.toString()).toBe(text);
  } finally {
    copy.mockRestore();
    view.destroy();
  }
});
it('commits an IME language only once, preserves original metadata and supports cancel and keyboard suggestions', () => {
  const original = '~~~  {#示例}\n说明\n~~~',
    view = open(original);
  try {
    const input = combobox(view);
    if (!input) throw Error('Expected language field');
    input.dispatchEvent(new Event('focus'));
    input.dispatchEvent(new Event('compositionstart'));
    input.value = '方言';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(view.state.doc.toString()).toBe(original);
    input.dispatchEvent(new Event('compositionend'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(view.state.doc.toString()).toBe('~~~  方言 {#示例}\n说明\n~~~');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
    const again = combobox(view);
    if (!again) throw Error('Expected restored language field');
    again.dispatchEvent(new Event('focus'));
    again.value = 'pyth';
    again.dispatchEvent(new Event('input'));
    expect(again.getAttribute('aria-expanded')).toBe('true');
    expect(view.dom.querySelector('[role=option]')?.textContent).toBe('python');
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(again.value).toBe('');
    expect(view.state.doc.toString()).toBe(original);
  } finally {
    view.destroy();
  }
});
it('closes a typed fence on Enter, guards both body edges and removes one empty card as an undoable edit', () => {
  const view = open('~~~rust');
  try {
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(press(view, 'Enter')).toBe(true);
    expect(view.state.doc.toString()).toBe('~~~rust\n\n~~~');
    expect(press(view, 'Delete')).toBe(true);
    view.dispatch(view.state.replaceSelection('汉'));
    expect(press(view, 'Delete')).toBe(true);
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    expect(press(view, 'Backspace')).toBe(true);
    expect(view.state.doc.toString()).toBe('~~~rust\n汉\n~~~');
    view.dispatch({
      changes: { from: view.state.doc.line(2).from, to: view.state.doc.line(2).to },
    });
    expect(press(view, 'Backspace')).toBe(true);
    expect(view.state.doc.length).toBe(0);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toContain('~~~rust');
  } finally {
    view.destroy();
  }
});
it.each([
  ['mermaid', '~~~mermaid title="graph"\nflowchart LR\n~~~'],
  ['math', '$$\nx^2\n$$'],
])(
  'reveals the source card of %s on a direct click and retains its rendering below',
  (kind, text) => {
    const view = open('Before\n\n' + text + '\n\nAfter');
    try {
      const rich = view.dom.querySelector<HTMLElement>('.md-rich-widget');
      expect(rich?.dataset.kind).toBe(kind);
      expect(view.dom.querySelector('.md-code-footer')).toBeNull();
      rich?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      expect(view.dom.querySelector('.md-code-footer')).toBeTruthy();
      expect(view.dom.querySelector('.md-rich-widget')?.textContent).toContain(
        kind === 'math' ? 'x^2' : 'flowchart LR',
      );
      if (kind === 'math') expect(combobox(view)).toBeNull();
      else expect(combobox(view)?.value).toBe('mermaid');
      view.dispatch({ selection: { anchor: 0 } });
      expect(view.dom.querySelector('.md-code-footer')).toBeNull();
    } finally {
      view.destroy();
    }
  },
);
