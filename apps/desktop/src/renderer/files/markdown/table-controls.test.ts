// @vitest-environment happy-dom
import { it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { Translator } from '../../../shared/i18n/index.js';
import { widgetHost } from './widget-host.js';
import { markdownSupport } from './language.js';
import { liveExtensions, liveMode } from './live-preview.js';
const raw = '| Name | Value  |\n| :----- | -----: |\n| A\\|B |  **1**  |\n| C | 2 |';
function editor(source = raw, locked = false) {
  const t = new Translator('en');
  const parent = document.createElement('div');
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: source,
      extensions: [
        markdownSupport(),
        history(),
        widgetHost.of({ t: (k, v) => t.t(k, v), mount: () => undefined, unmount: () => undefined }),
        liveMode.of(true),
        ...liveExtensions,
        EditorState.readOnly.of(locked),
      ],
    }),
  });
}
function hover(view: EditorView, row: number, col: number) {
  const cell = view.dom.querySelector('table')?.rows[row]?.cells[col];
  if (!cell) throw new Error('Missing table cell');
  cell.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  return cell;
}
function button(view: EditorView, which: string) {
  const b = view.dom.querySelector<HTMLButtonElement>('[data-table-control="' + which + '"]');
  expect(b, which).not.toBeNull();
  if (!b) throw new Error(which);
  return b;
}
function action(view: EditorView, id: string) {
  const item = view.dom.querySelector('[data-table-action="' + id + '"]');
  if (!(item instanceof HTMLButtonElement)) throw new Error('Missing table command ' + id);
  item.click();
}
it('hover exposes axis, corner and boundary handles without moving the caret or editing the document', () => {
  const v = editor();
  try {
    hover(v, 2, 1);
    for (const which of ['row', 'column', 'corner', 'append-row', 'append-column'])
      expect(button(v, which).hidden).toBe(false);
    expect(v.state.doc.toString()).toBe(raw);
    expect(v.state.selection.main.head).toBe(0);
    hover(v, 0, 0);
    expect(button(v, 'append-row').hidden).toBe(true);
    expect(button(v, 'append-column').hidden).toBe(true);
  } finally {
    v.destroy();
  }
});
it('duplicates a hovered row from its grip and undoes the operation in one step', () => {
  const v = editor();
  try {
    hover(v, 1, 1);
    button(v, 'row').click();
    action(v, 'duplicateRow');
    expect(v.state.doc.toString()).toBe(raw.replace('| C |', '| A\\|B |  **1**  |\n| C |'));
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(raw);
    expect(redo(v)).toBe(true);
  } finally {
    v.destroy();
  }
});
it('cell context menu takes precedence, addresses the clicked column, and supports keyboard dismissal', () => {
  const v = editor();
  try {
    const cell = hover(v, 1, 1);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 40,
    });
    cell.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    v.dom.querySelector<HTMLButtonElement>('.md-table-menu-tabs button:nth-child(2)')?.click();
    action(v, 'align');
    action(v, 'alignCenter');
    expect(v.state.doc.toString()).toContain('| :----- | :-----: |');
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(raw);
    hover(v, 1, 1);
    button(v, 'column').click();
    const menu = v.dom.querySelector('[role=menu]');
    expect(menu).not.toBeNull();
    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
    );
    expect(v.dom.querySelector('[role=menu]')).toBeNull();
    expect(v.state.doc.toString()).toBe(raw);
  } finally {
    v.destroy();
  }
});
it('excludes mutation controls in read-only mode', () => {
  const v = editor(raw, true);
  try {
    hover(v, 1, 0);
    expect(v.dom.querySelector('[data-table-control]')).toBeNull();
  } finally {
    v.destroy();
  }
});
it('honors the Lezer range in quoted list items, restores the exact raw container, and discards stale popup actions', () => {
  const nested = 'Before\n\n> - Item\n>\n>   ' + raw.replaceAll('\n', '\n>   ') + '\n\nAfter';
  const v = editor(nested);
  try {
    hover(v, 1, 0);
    button(v, 'row').click();
    const retired = v.dom.querySelector<HTMLButtonElement>('[data-table-action="deleteRow"]');
    expect(retired).not.toBeNull();
    v.dom
      .querySelector('[role=menu]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
      );
    retired?.click();
    expect(v.state.doc.toString()).toBe(nested);
    hover(v, 1, 0);
    button(v, 'row').click();
    action(v, 'duplicateRow');
    expect(v.state.doc.toString()).toBe(
      nested.replace('>   | C |', '>   | A\\|B |  **1**  |\n>   | C |'),
    );
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe(nested);
  } finally {
    v.destroy();
  }
});
it('keeps input method composition and a concurrent edit from executing a stale row menu', () => {
  const v = editor();
  try {
    const cell = hover(v, 1, 0);
    button(v, 'row').click();
    const action = v.dom.querySelector<HTMLButtonElement>('[data-table-action="deleteRow"]');
    const input = cell.querySelector('input');
    input?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(v.dom.querySelector('[role=menu]')).toBeNull();
    action?.click();
    expect(v.state.doc.toString()).toBe(raw);
    input?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    hover(v, 1, 0);
    button(v, 'row').click();
    const old = v.dom.querySelector<HTMLButtonElement>('[data-table-action="deleteRow"]');
    const at = raw.indexOf('first');
    v.dispatch({ changes: { from: at < 0 ? raw.lastIndexOf('C') : at, insert: 'other-' } });
    old?.click();
    expect(v.state.doc.toString()).toContain('| other-C |');
  } finally {
    v.destroy();
  }
});
it('pastes a multi-cell selection, retains one undo step and protects the header and last column', () => {
  const v = editor('| A |\n| --- |\n| 1 |');
  try {
    const header = hover(v, 0, 0);
    button(v, 'row').click();
    expect(
      v.dom.querySelector<HTMLButtonElement>('[data-table-action="deleteRow"]')?.disabled,
    ).toBe(true);
    v.dom.querySelector<HTMLButtonElement>('.md-table-menu-tabs button:nth-child(2)')?.click();
    expect(
      v.dom.querySelector<HTMLButtonElement>('[data-table-action="deleteColumn"]')?.disabled,
    ).toBe(true);
    v.dom
      .querySelector('[role=menu]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    const clip = new DataTransfer();
    clip.setData('text/plain', 'A\tB\n1\t2');
    header
      .querySelector('input')
      ?.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clip }),
      );
    expect(v.state.doc.toString()).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('| A |\n| --- |\n| 1 |');
  } finally {
    v.destroy();
  }
});
