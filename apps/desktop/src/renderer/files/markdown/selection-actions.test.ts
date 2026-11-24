// @vitest-environment happy-dom
import { it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { Translator } from '../../../shared/i18n/index.js';
import { widgetHost } from './widget-host.js';
import { markdownSupport } from './language.js';
import { selectionTools } from './selection-tools.js';

function create(text: string, from: number, to: number) {
  const t = new Translator('en');
  const container = document.createElement('div');
  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        markdownSupport(),
        widgetHost.of({
          t: (id, args) => t.t(id, args),
          mount: () => undefined,
          unmount: () => undefined,
        }),
        selectionTools,
      ],
    }),
  });
  view.dispatch({ selection: { anchor: from, head: to } });
  return {
    view,
    close: () => {
      view.destroy();
      container.remove();
    },
  };
}
it('offers the heading, inline and list groups, retains the original selection and reflects its current formatting', () => {
  const { view, close } = create('A clear plan', 2, 7);
  try {
    const bar = view.dom.querySelector('[role=toolbar]');
    if (!bar) throw new Error('Missing selection toolbar');
    expect(
      [...bar.querySelectorAll('[data-command]')].map((b) => (b as HTMLElement).dataset.command),
    ).toEqual([
      'h1',
      'h2',
      'h3',
      'bold',
      'italic',
      'strike',
      'inlineCode',
      'inlineMath',
      'link',
      'bullet',
      'ordered',
      'task',
      'quote',
    ]);
    expect(bar.querySelectorAll('[role=separator]')).toHaveLength(2);
    view.dom.querySelector<HTMLButtonElement>('[data-command=bold]')?.click();
    expect(view.state.doc.toString()).toBe('A **clear** plan');
    expect(view.dom.querySelector('[data-command=bold]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'clear',
    );
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('A clear plan');
    view.dom.querySelector<HTMLButtonElement>('[data-command=h2]')?.click();
    expect(view.state.doc.toString()).toBe('## A clear plan');
    expect(view.dom.querySelector('[data-command=h2]')?.getAttribute('aria-pressed')).toBe('true');
  } finally {
    close();
  }
});
it('suppresses selection formatting across an intervening code block as well as within a block', () => {
  const text = 'one\n\n```ts\nx = 1\n```\n\ntwo';
  const { view, close } = create(text, 1, text.length - 1);
  try {
    expect(view.dom.querySelector('[role=toolbar]')).toBeNull();
  } finally {
    close();
  }
});

it('round trips all extended marks on a backward selection and reports their pressed state', async () => {
  const { applyFormat, formatActive } = await import('./formatting.js');
  for (const [command, expected] of [
    ['underline', '<u>word</u>'],
    ['inlineMath', '$word$'],
    ['superscript', '^word^'],
    ['subscript', '~word~'],
    ['highlight', '==word=='],
  ] as const) {
    const { view, close } = create('word', 4, 0);
    try {
      expect(applyFormat(view, command, String)).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      expect(view.state.selection.main.anchor).toBeGreaterThan(view.state.selection.main.head);
      expect(formatActive(view.state, command)).toBe(true);
      expect(applyFormat(view, command, String)).toBe(true);
      expect(view.state.doc.toString()).toBe('word');
    } finally {
      close();
    }
  }
});
