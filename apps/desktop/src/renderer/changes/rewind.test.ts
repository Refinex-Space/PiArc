import { describe, expect, it } from 'vitest';

import {
  affectedFiles,
  initialChoices,
  previewOf,
  reportOf,
  requestOf,
  restoresCode,
} from './rewind.js';

const preview = previewOf(
  JSON.stringify({
    turnId: 'turn-1',
    codeAvailable: true,
    files: [
      { path: '/w/a.txt', label: 'a.txt', action: 'restore', version: 'v1' },
      { path: '/w/b.txt', label: 'b.txt', action: 'conflict', version: 'v2', deletes: true },
      { path: '/w/c.txt', label: 'c.txt', action: 'unchanged', version: 'v3' },
      { path: '/o.txt', label: '/o.txt', action: 'delete', version: 'v4', approval: true },
      { path: '/w/x', label: 'x', action: 'explode', version: 'v5' },
    ],
  }),
);

describe('rewind', () => {
  it('parses the preview and skips malformed files', () => {
    expect(preview.files.map((f) => f.action)).toEqual([
      'restore',
      'conflict',
      'unchanged',
      'delete',
    ]);
    expect(preview.files[1]?.deletes).toBe(true);
    expect(preview.files[3]?.approval).toBe(true);
    expect(affectedFiles(preview).map((f) => f.label)).toEqual(['a.txt', 'b.txt', '/o.txt']);
    expect(() => previewOf('{}')).toThrow(/malformed/);
  });

  it('keeps conflicts unless the user chooses to overwrite, and sends choices only for code', () => {
    const choices = new Map(initialChoices(preview));
    expect([...choices]).toEqual([['/w/b.txt', false]]);
    expect(requestOf(preview, 'conversation', choices)).toEqual({
      turnId: 'turn-1',
      scope: 'conversation',
    });
    choices.set('/w/b.txt', true);
    expect(requestOf(preview, 'code', choices)).toEqual({
      turnId: 'turn-1',
      scope: 'code',
      choices: [{ path: '/w/b.txt', version: 'v2', overwrite: true }],
    });
    expect(restoresCode('codeAndConversation')).toBe(true);
    expect(restoresCode('summarize')).toBe(false);
  });

  it('parses the report with per-file outcomes, the undo id and the text back', () => {
    const report = reportOf(
      JSON.stringify({
        completed: false,
        restoreId: 'restore-1',
        files: [
          { path: '/w/a.txt', label: 'a.txt', outcome: 'restored' },
          { path: '/w/b.txt', label: 'b.txt', outcome: 'failed', error: 'permission denied' },
          { path: '/w/c.txt', label: 'c.txt', outcome: 'skipped' },
        ],
        conversation: { text: 'Add a file.' },
        error: 'b.txt: permission denied',
      }),
    );
    expect(report.files?.map((f) => f.outcome)).toEqual(['restored', 'failed', 'skipped']);
    expect(report.restoreId).toBe('restore-1');
    expect(report.conversation?.text).toBe('Add a file.');
    expect(reportOf(JSON.stringify({ completed: true })).files).toEqual([]);
  });
});
