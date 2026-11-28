// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { Compartment, EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { applyFormat } from './formatting.js';
import { parseTable, setCell, alignColumn } from './table-model.js';
import { editRegion } from './table-operations.js';
import { liveMode } from './live-preview.js';
import { markdownSupport } from './language.js';
import { patchSource, applyUserChange } from './MarkdownEditor.js';
import { imageTargets, imagePort, insertImages, externalReload } from './image-import.js';

function surface(text: string, options: Parameters<typeof EditorState.create>[0] = {}) {
  // Exercise CM transactions independently of the browser's native selectionchange timing.
  const parent = document.createElement('div');
  const view = new EditorView({ parent, state: EditorState.create({ ...options, doc: text }) });
  return {
    view,
    dispose: () => {
      view.destroy();
      parent.remove();
    },
  };
}
describe('the Markdown editing document', () => {
  it('keeps one undo history and exact selection across source and live presentation', () => {
    const compartment = new Compartment();
    const { view, dispose } = surface('hello world', {
      selection: EditorSelection.single(6, 11),
      extensions: [history(), markdownSupport(), compartment.of(liveMode.of(true))],
    });
    try {
      expect(applyFormat(view, 'bold', String)).toBe(true);
      expect(view.state.doc.toString()).toBe('hello **world**');
      expect(
        view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to),
      ).toBe('world');
      view.dispatch({ effects: compartment.reconfigure(liveMode.of(false)) });
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('hello world');
      expect(redo(view)).toBe(true);
      expect(applyFormat(view, 'bold', String)).toBe(true);
      expect(view.state.doc.toString()).toBe('hello world');
    } finally {
      dispose();
    }
  });
  it('undoes a reading-view task toggle without losing another edit or moving the caret', () => {
    const { view, dispose } = surface('- [ ] Task\nTail', { extensions: [history()] });
    try {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: '!' },
        selection: { anchor: 3 },
        userEvent: 'input.type',
      });
      applyUserChange(view, '- [x] Task\nTail!');
      expect(view.state.selection.main.head).toBe(3);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- [ ] Task\nTail!');
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('- [ ] Task\nTail');
    } finally {
      dispose();
    }
  });
  it('applies edits in UTF-16 coordinates without rewriting untouched CRLF or mixed newlines', () => {
    const source = '✨ Intro\r\n\r\nA markdown 表格\nTail\r\n';
    const state = EditorState.create({ doc: source });
    const at = state.doc.line(3).from;
    const change = state.update({
      changes: [
        { from: at, to: at + 1, insert: 'My' },
        { from: state.doc.line(4).to, insert: '!' },
      ],
    });
    expect(patchSource(source, change)).toBe('✨ Intro\r\n\r\nMy markdown 表格\nTail!\r\n');
  });
  it('edits table cells and structure directly in the original GFM source', () => {
    const text = '| key | value |\n| :--- | ---: |\n| a\\|b | a |\n| z | 2 |';
    const t = parseTable(text, 0);
    if (!t) throw new Error('Expected table');
    const state = EditorState.create({ doc: text });
    const update = (changes: TransactionSpec) => state.update(changes).newDoc.toString();
    expect(update({ changes: setCell(t, 1, 1, 'x|y') ?? [] })).toContain('| a\\|b | x\\|y |');
    const first = { top: 1, bottom: 1, left: 0, right: 0 };
    expect(update({ changes: editRegion(t, first, 'addColumn') })).toContain('| key |  | value |');
    expect(update({ changes: editRegion(t, first, 'deleteColumn') })).toContain('| value |');
    expect(update({ changes: editRegion(t, first, 'moveDown') })).toContain(
      '| z | 2 |\n| a\\|b | a |',
    );
    expect(update({ changes: alignColumn(t, 0, 'center') ?? [] })).toContain('| :---: | ---: |');
  });
  it('maps an async file chooser through typing and leaves a later caret in place', async () => {
    const result = Promise.withResolvers<string | null>();
    const { view, dispose } = surface('hello world', {
      selection: EditorSelection.single(5),
      extensions: [
        imageTargets,
        imagePort.of(() => ({
          view: () => view,
          chooseImage: () => result.promise,
          error: (e) => {
            throw e;
          },
        })),
      ],
    });
    try {
      const importing = insertImages(view);
      view.dispatch({ changes: { from: 0, insert: '!' }, selection: { anchor: 0 } });
      result.resolve('![x](x.png)');
      await importing;
      expect(view.state.doc.toString()).toBe('!hello![x](x.png) world');
      expect(view.state.selection.main.head).toBe(0);
    } finally {
      dispose();
    }
  });
  it('cancels an outstanding image insertion after an external file reload', async () => {
    const result = Promise.withResolvers<readonly string[]>();
    const { view, dispose } = surface('old', {
      extensions: [
        imageTargets,
        imagePort.of(() => ({
          view: () => view,
          importImages: () => result.promise,
          error: (e) => {
            throw e;
          },
        })),
      ],
    });
    try {
      const importing = insertImages(view, [new File(['x'], 'x.png')]);
      view.dispatch({
        changes: { from: 0, to: 3, insert: 'new' },
        annotations: externalReload.of(true),
      });
      result.resolve(['![x](x)']);
      await importing;
      expect(view.state.doc.toString()).toBe('new');
    } finally {
      dispose();
    }
  });
});

it('parses semantic inline markers in editable Markdown without changing strikethrough, fenced examples or tags with attributes', async () => {
  const { syntaxTree } = await import('@codemirror/language');
  const state = EditorState.create({
    doc: '==**marked**== H~2~O x^2^ <u>under</u> ~~gone~~ `^literal^` <u class=x>plain</u>',
    extensions: [markdownSupport()],
  });
  const tree: string[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      tree.push(node.name);
    },
  });
  for (const node of [
    'Highlight',
    'Superscript',
    'Subscript',
    'Underline',
    'Strikethrough',
    'InlineCode',
  ])
    expect(tree).toContain(node);
  expect(tree.filter((node) => node === 'Underline')).toHaveLength(1);
});
