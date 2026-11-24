// @vitest-environment happy-dom
import { it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { Translator } from '../../../shared/i18n/index.js';
import { widgetHost } from './widget-host.js';
import { markdownSupport } from './language.js';
import { slashMenu, slashState } from './slash-menu.js';
import { selectionTools } from './selection-tools.js';
import { fenceLanguages } from './fence-language.js';

function editor(text = '', readonly = false) {
  const t = new Translator('en');
  const parent = document.createElement('div');
  const state = EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(text.length),
    extensions: [
      history(),
      markdownSupport(),
      widgetHost.of({ t: (k, v) => t.t(k, v), mount: () => undefined, unmount: () => undefined }),
      slashMenu,
      selectionTools,
      fenceLanguages,
      EditorState.readOnly.of(readonly),
    ],
  });
  return new EditorView({ state, parent });
}
function type(view: EditorView, value: string, userEvent = 'input.type') {
  view.dispatch({ ...view.state.replaceSelection(value), userEvent });
}
function key(view: EditorView, name: string, compose = false) {
  const e = new KeyboardEvent('keydown', {
    key: name,
    isComposing: compose,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(e);
  return e;
}
it('filters line-leading slash commands, selects by keyboard and undoes the insertion as one edit', () => {
  const v = editor('Title\n\n');
  try {
    type(v, '/');
    expect(v.state.field(slashState)?.query).toBe('');
    expect(v.dom.querySelector('[role=listbox]')).not.toBeNull();
    key(v, 'ArrowDown');
    expect(v.state.field(slashState)?.active).toBe(1);
    type(v, 'table');
    expect(v.dom.querySelector('[role=option]')?.textContent).toBe('Insert table');
    key(v, 'Enter');
    expect(v.state.doc.toString()).toContain('| Column 1 |');
    expect(v.state.doc.toString()).not.toContain('/table');
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('Title\n\n/table');
  } finally {
    v.destroy();
  }
});
it('leaves paths, paste, escaped commands and input method composition alone', () => {
  for (const [prior, text, event] of [
    ['src', '/', 'input.type'],
    ['', '/', 'input.paste'],
    ['', '/', 'input.type.compose'],
    ['    ', '/', 'input.type'],
    ['```\n', '/', 'input.type'],
  ] as const) {
    const v = editor(prior);
    try {
      type(v, text, event);
      expect(v.dom.querySelector('[role=listbox]')).toBeNull();
    } finally {
      v.destroy();
    }
  }
  const v = editor();
  try {
    type(v, '/');
    type(v, 'home/user');
    expect(v.dom.querySelector('[role=listbox]')).toBeNull();
    expect(key(v, 'Enter').defaultPrevented).toBe(false);
    v.dispatch({
      changes: { from: 0, to: v.state.doc.length, insert: '' },
      selection: { anchor: 0 },
    });
    type(v, '/');
    expect(key(v, 'Enter', true).defaultPrevented).toBe(false);
    expect(v.state.doc.toString()).toBe('/');
    key(v, 'Escape');
    type(v, 'h1');
    expect(v.dom.querySelector('[role=listbox]')).toBeNull();
    expect(v.state.doc.toString()).toBe('/h1');
  } finally {
    v.destroy();
  }
});
it('applies floating selection formatting to the selected range, preserving fenced code and read-only files', () => {
  const v = editor('A great idea');
  try {
    v.dispatch({ selection: { anchor: 2, head: 7 } });
    const toolbar = v.dom.querySelector<HTMLElement>('[role=toolbar]');
    const button = toolbar?.querySelector<HTMLButtonElement>('[data-command=bold]');
    expect(button).toBeTruthy();
    button?.click();
    expect(v.state.doc.toString()).toBe('A **great** idea');
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('great');
  } finally {
    v.destroy();
  }
  for (const [body, readOnly] of [
    ['```ts\nlet n\n```', false],
    ['some text', true],
  ] as const) {
    const locked = editor(body, readOnly);
    try {
      locked.dispatch({ selection: { anchor: body.indexOf(' '), head: body.indexOf(' ') + 2 } });
      expect(locked.dom.querySelector('[role=toolbar]')).toBeNull();
    } finally {
      locked.destroy();
    }
  }
});
it('updates only the language token from the fence picker, preserving metadata, delimiter, body and undo', () => {
  const body = '~~~ts title="demo"\nlet n = 3;\n~~~~';
  const view = editor(body);
  try {
    const field = view.dom.querySelector<HTMLSelectElement>('select.md-fence-lang');
    expect(field?.value).toBe('ts');
    if (!field) throw new Error('Missing code language selector');
    field.dispatchEvent(new FocusEvent('focus'));
    field.value = 'python';
    field.dispatchEvent(new Event('change'));
    expect(view.state.doc.toString()).toBe('~~~python title="demo"\nlet n = 3;\n~~~~');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(body);
  } finally {
    view.destroy();
  }
});

it('groups insertion commands, shows syntax hints and chooses a nested diagram with arrows', () => {
  const v = editor();
  try {
    type(v, '/');
    const list = v.dom.querySelector('[role=listbox]');
    expect(list?.querySelectorAll('[role=group]')).toHaveLength(3);
    expect(list?.querySelector('[data-command=h2] [data-hint]')?.getAttribute('data-hint')).toBe(
      '##',
    );
    const folder = list?.querySelector<HTMLElement>('[data-folder=diagram]');
    expect(folder).toBeTruthy();
    folder?.click();
    expect(v.dom.querySelector('[role=listbox][aria-label="Mermaid diagram"]')).toBeTruthy();
    const submenu = v.dom.querySelector('[role=listbox][aria-label="Mermaid diagram"]');
    expect(submenu?.querySelector('button')).toBeNull();
    expect(submenu?.querySelectorAll('[role=option]')).toHaveLength(8);
    key(v, 'ArrowLeft');
    expect(v.dom.querySelectorAll('[role=listbox]')).toHaveLength(1);
    key(v, 'ArrowRight');
    key(v, 'ArrowDown');
    key(v, 'Enter');
    expect(v.state.doc.toString()).toContain('sequenceDiagram');
    undo(v);
    expect(v.state.doc.toString()).toBe('/');
  } finally {
    v.destroy();
  }
});

it('opens at a word boundary with the Chinese trigger, resolves initials and inserts a warning in one edit', () => {
  const v = editor('Notes ');
  try {
    type(v, '、');
    type(v, 'jg');
    expect(v.dom.querySelector('[role=option]')?.getAttribute('data-command')).toBe(
      'callout-warning',
    );
    key(v, 'Tab');
    expect(v.state.doc.toString()).toMatch(/^Notes\s*\n\n> \[!WARNING\]\n> /);
    undo(v);
    expect(v.state.doc.toString()).toBe('Notes 、jg');
  } finally {
    v.destroy();
  }
});

it('finds footnotes, metadata, syntax markers and deeper headings from either locale', () => {
  for (const [query, command] of [
    ['jz', 'footnote'],
    ['ysj', 'frontMatter'],
    ['######', 'h6'],
    ['lct', 'diagram-flowchart'],
  ] as const) {
    const v = editor('Existing[^1]\n\n[^1]: source\n\n');
    try {
      type(v, '/');
      type(v, query);
      expect(v.dom.querySelector('[role=option]')?.getAttribute('data-command')).toBe(command);
      key(v, 'Enter');
      if (command === 'footnote') expect(v.state.doc.toString()).toContain('[^2]\n\n[^2]: ');
      if (command === 'frontMatter') expect(v.state.doc.toString()).toMatch(/^---\ntitle: \n---/);
    } finally {
      v.destroy();
    }
  }
});

it('inserts a chosen block after the surrounding paragraph when slash is used before existing text', () => {
  const v = editor('A paragraph ends here.');
  try {
    v.dispatch({ selection: { anchor: 2 } });
    type(v, '/');
    type(v, 'warning');
    key(v, 'Enter');
    expect(v.state.doc.toString()).toBe('A paragraph ends here.\n\n> [!WARNING]\n> \n');
  } finally {
    v.destroy();
  }
});

it('shows the callout label in live editing while keeping its literal marker in the shared document', async () => {
  const { liveMode, liveExtensions } = await import('./live-preview.js');
  const t = new Translator('en');
  const text = 'Start\n\n> [!TIP]\n> A practical suggestion.\n';
  const view = new EditorView({
    parent: document.createElement('div'),
    state: EditorState.create({
      doc: text,
      extensions: [
        markdownSupport(),
        liveMode.of(true),
        ...liveExtensions,
        widgetHost.of({
          t: (id, values) => t.t(id, values),
          mount: () => undefined,
          unmount: () => undefined,
        }),
      ],
    }),
  });
  try {
    expect(view.dom.querySelector('.md-callout-title')?.textContent).toBe('Tip');
    expect(view.dom.querySelectorAll('.md-callout-tip')).toHaveLength(2);
    expect(view.state.doc.toString()).toBe(text);
  } finally {
    view.destroy();
  }
});
