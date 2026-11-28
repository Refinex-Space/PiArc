// @vitest-environment happy-dom
import type { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdownSupport } from './language.js';
import { expect, it, vi } from 'vitest';
import { mediaAtSource } from './media-context-item.js';
it('finds a local image under the insertion point and preserves its escaped destination', () => {
  const text = 'before ![Map](./assets/map%20one.png) after';
  const state = EditorState.create({ doc: text, extensions: markdownSupport() });
  expect(mediaAtSource(state, text.indexOf('Map') + 1)).toEqual({
    kind: 'image',
    source: './assets/map%20one.png',
    label: 'Map',
  });
  expect(mediaAtSource(state, 2)).toBeUndefined();
});
it('opens Mermaid content from the whole source fence but never treats an ordinary code block or remote image as local media', () => {
  const text =
    '~~~mermaid\nflowchart LR\n  A --> B\n~~~\n\n```js\nconst x = 1\n```\n\n![remote](https://example.com/map.png)';
  const state = EditorState.create({ doc: text, extensions: markdownSupport() });
  expect(mediaAtSource(state, text.indexOf('A --> B') + 1)).toEqual({
    kind: 'diagram',
    source: 'flowchart LR\n  A --> B',
  });
  expect(mediaAtSource(state, text.indexOf('const x'))).toBeUndefined();
  expect(mediaAtSource(state, text.indexOf('remote') + 1)).toBeUndefined();
});

it('dispatches only to the originating editor shadow tree while its source and workspace still match', async () => {
  const { mediaContextItem, bindMediaContext } = await import('./media-context-item.js');
  const article = '![Map](local.png)',
    root = document.createElement('div');
  root.className = 'markdown-workspace';
  const mount = root.appendChild(document.createElement('div')),
    shadow = mount.attachShadow({ mode: 'open' }),
    element = shadow.appendChild(document.createElement('div'));
  document.body.append(root);
  const open = vi.fn(),
    unregister = bindMediaContext(root, open);
  let state = EditorState.create({ doc: article, extensions: markdownSupport() });
  const view = {
    dom: element,
    get state() {
      return state;
    },
    focus: vi.fn(),
  } as unknown as EditorView;
  try {
    const item = mediaContextItem(element, view, 3, (key) => key);
    expect(item?.id).toBe('view-media');
    if (!item?.run) throw new Error('Missing command');
    item.run();
    expect(open).toHaveBeenCalledWith(
      { kind: 'image', source: 'local.png', label: 'Map' },
      expect.any(Function),
    );
    state = state.update({ changes: { from: 0, insert: 'Changed ' } }).state;
    item.run();
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    unregister();
    root.remove();
  }
});
