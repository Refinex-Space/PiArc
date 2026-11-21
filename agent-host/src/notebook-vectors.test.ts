// T42: the shared NotebookEdit vectors (`tests/notebook/`), byte for byte, as Core's
// `piarc_fs::notebook` runs them: the two copies of the algorithm must agree.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { editNotebook, newCellId, NotebookError, type CellEdit } from './tools/notebook-text.js';

const DIR = new URL('../../tests/notebook/', import.meta.url);

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, DIR)), 'utf8');
}

interface Case {
  readonly name: string;
  readonly notebook: string;
  readonly edit: CellEdit;
  readonly expected?: string;
  readonly error?: string;
}

function cases(): Case[] {
  const parsed: unknown = JSON.parse(read('cases.json'));
  if (typeof parsed !== 'object' || parsed === null || !('cases' in parsed)) {
    throw new Error('cases.json has no cases');
  }
  return (parsed as { cases: Case[] }).cases;
}

describe('notebook cell edits', () => {
  it.each(cases().map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const input = read(c.notebook);
    if (c.expected !== undefined) {
      expect(editNotebook(input, c.edit)).toBe(read(c.expected));
    } else {
      let caught: unknown;
      try {
        editNotebook(input, c.edit);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(NotebookError);
      expect((caught as NotebookError).kind).toBe(c.error);
    }
  });

  it('derives new ids like Core', () => {
    const first = newCellId('call', []);
    expect(first).toMatch(/^[0-9a-f]{8}$/u);
    expect(newCellId('call', [first])).not.toBe(first);
  });
});
