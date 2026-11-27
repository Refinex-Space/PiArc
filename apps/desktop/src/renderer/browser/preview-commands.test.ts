import { describe, expect, it } from 'vitest';

import type { BrowserPick } from '../../shared/browser.js';
import {
  onPreviewCommand,
  requestPreviewCommand,
  scopeSource,
  trayItems,
} from './preview-commands.js';

function pick(path?: string): BrowserPick {
  return {
    id: 'p',
    tab: 'tab-1',
    context: {
      url: 'http://h/',
      tag: 'div',
      selector: 'div',
      xpath: '/html/body/div',
      role: '',
      name: '',
      attributes: {},
      text: '',
      html: '',
      styles: {},
      box: { x: 0, y: 0, width: 1, height: 1 },
      components: ['App'],
      ...(path === undefined ? {} : { source: { path, line: 3 } }),
    },
  };
}

describe('source paths for the session', () => {
  it('keeps workspace paths when the session works in the workspace', () => {
    expect(scopeSource(pick('src/App.tsx'), '/w', '/w').context.source?.path).toBe('src/App.tsx');
  });

  it('makes paths relative to a worktree session’s checkout', () => {
    const scoped = scopeSource(
      pick('.piarc/worktrees/x/src/App.tsx'),
      '/w',
      '/w/.piarc/worktrees/x',
    );
    expect(scoped.context.source).toEqual({ path: 'src/App.tsx', line: 3 });
  });

  it('drops a source outside the session’s file root (only the component shows)', () => {
    const scoped = scopeSource(pick('src/App.tsx'), '/w', '/w/.piarc/worktrees/x');
    expect(scoped.context.source).toBeUndefined();
    expect(scoped.context.components).toEqual(['App']);
  });

  it('compares Windows paths without case', () => {
    const scoped = scopeSource(
      pick('.piarc/worktrees/X/src/a.ts'),
      'C:\\W',
      'c:\\w\\.piarc\\worktrees\\x',
    );
    expect(scoped.context.source?.path).toBe('src/a.ts');
  });
});

describe('preview commands', () => {
  it('waits for the panel when it is not mounted yet', () => {
    requestPreviewCommand('s-1', 'annotate');
    const seen: string[] = [];
    const stop = onPreviewCommand('s-1', (command) => seen.push(command));
    requestPreviewCommand('s-1', 'pick');
    expect(seen).toEqual(['annotate', 'pick']);
    stop();
  });

  it('numbers the tray’s cards in order', () => {
    expect(
      trayItems([
        { pick: pick(), comment: 'a' },
        { pick: pick(), comment: '' },
      ]).map((i) => [i.n, i.comment]),
    ).toEqual([
      [1, 'a'],
      [2, ''],
    ]);
  });
});
