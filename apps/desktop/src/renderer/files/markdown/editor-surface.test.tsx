// @vitest-environment happy-dom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { DEFAULT_PREFERENCES } from '../../../shared/preferences.js';
import { AppProvider } from '../../app/app-context.js';
import { DEFAULT_VIEWER_SETTINGS } from '../viewer-model.js';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor.js';

it('mounts a Markdown source editor, edits rich table cells and keeps both the draft and history on a mode switch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', { onAppEvent: () => () => undefined });
  const host = document.createElement('div');
  const root = createRoot(host); // Detached to test model and rendered controls independently of native selection timing.
  const controller = createRef<MarkdownEditorHandle>(),
    changes: string[] = [];
  let draft = '# Title\n\n| Day | Name |\n| --- | --- |\n| 1 | hello |\n\nEnd';
  const render = async (mode: 'live' | 'source') => {
    await act(async () => {
      root.render(
        <AppProvider
          initial={{
            platform: 'darwin',
            focused: true,
            notificationsSupported: false,
            locale: 'en',
            preferences: DEFAULT_PREFERENCES,
          }}
        >
          <MarkdownEditor
            sessionId="unit"
            path="note.md"
            mode={mode}
            text={draft}
            settings={DEFAULT_VIEWER_SETTINGS}
            ref={controller}
            onSelect={() => undefined}
            onChange={(s) => {
              changes.push(s);
              draft = s;
            }}
          />
        </AppProvider>,
      );
      await Promise.resolve();
    });
  };
  try {
    await render('live');
    expect(host.querySelector('.md-edit-toolbar')).toBeNull();
    const shadow = host.querySelector('.md-editor-mount')?.shadowRoot;
    const field = shadow?.querySelector<HTMLTextAreaElement>(
      'tbody textarea[aria-label="Row 2, column 2"]',
    );
    expect(field?.value).toBe('hello');
    await act(async () => {
      if (!field) throw new Error('Missing table field');
      field.value = 'Ada';
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Ada' }));
      await Promise.resolve();
    });
    expect(draft).toContain('| 1 | Ada |');
    await render('source');
    expect(host.querySelector('.md-edit-toolbar')).toBeNull();
    expect(shadow?.querySelector('table')).toBeNull();
    const content = shadow?.querySelector<HTMLElement>('.cm-content');
    expect(content?.getAttribute('aria-label')).toBe('Markdown source editor');
    const view = content && EditorView.findFromDOM(content);
    expect(view?.state.doc.toString()).toBe(draft);
    act(() => {
      if (!view) throw new Error('Missing editor view');
      undo(view);
    });
    expect(changes.at(-1)).toContain('| 1 | hello |');
    await render('live');
    expect(
      shadow?.querySelector<HTMLTextAreaElement>('tbody textarea[aria-label="Row 2, column 2"]')
        ?.value,
    ).toBe('hello');
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    vi.unstubAllGlobals();
  }
});
