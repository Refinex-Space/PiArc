import { describe, expect, it } from 'vitest';

import { changesOf, SessionChanges } from './changes.js';

const view = {
  files: [
    {
      path: '/w/a.ts',
      label: 'a.ts',
      kind: 'modified',
      version: 'v1',
      added: 2,
      removed: 1,
      diff: {
        path: 'a.ts',
        added: 2,
        removed: 1,
        unified: '@@',
        hunks: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            lines: [
              { kind: 'removed', text: 'a' },
              { kind: 'added', text: 'b' },
              { kind: 'added', text: 'c', noNewline: true },
            ],
          },
        ],
      },
    },
    {
      path: '/w/b.bin',
      label: 'b.bin',
      kind: 'created',
      version: 'v2',
      added: 0,
      removed: 0,
      binary: true,
    },
    { path: '/w/x', label: 'x', kind: 'renamed', version: 'v3', added: 0, removed: 0 },
  ],
  added: 2,
  removed: 1,
};

describe('SessionChanges', () => {
  it('parses Core’s view and skips malformed files', () => {
    const parsed = changesOf(JSON.stringify(view));
    expect(parsed.files.map((f) => f.label)).toEqual(['a.ts', 'b.bin']);
    expect(parsed.files[0]?.diff?.hunks[0]?.lines[2]?.noNewline).toBe(true);
    expect(parsed.files[1]?.binary).toBe(true);
    expect(changesOf('[]')).toEqual({ files: [], added: 0, removed: 0 });
  });

  it('keeps only the newest answer and recounts after a file changes', async () => {
    const changes = new SessionChanges();
    let first: (text: string) => void = () => undefined;
    const older = changes.refresh(
      () =>
        new Promise((resolve) => {
          first = resolve;
        }),
    );
    await changes.refresh(() => Promise.resolve(JSON.stringify(view)));
    first(JSON.stringify({ files: [], added: 0, removed: 0 }));
    await older;
    expect(changes.state().view?.files).toHaveLength(2);
    changes.replaceFile('/w/a.ts', undefined);
    expect(changes.state().view).toMatchObject({ added: 0, removed: 0 });
    await changes.refresh(() => Promise.reject(new Error('offline')));
    expect(changes.state().failure).toBe('offline');
    expect(changes.state().view?.files).toHaveLength(1);
  });
});
