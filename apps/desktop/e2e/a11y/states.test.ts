// T43-A02: the accessibility state list covers what the renderer registers. Every settings page
// (`registerSettingsPage`), rail and dock panel (`registerPanel`), file that renders a `<Dialog>`
// and transcript row kind (`ROW_KINDS`) needs an entry in `states.ts`; a new one fails here until
// it is listed (and reached by `t43-a11y.e2e.ts`, which checks every listed state).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ROW_KINDS } from '../../src/shared/row-kinds.js';
import { A11Y_STATES } from './states.js';

const RENDERER = path.join(import.meta.dirname, '..', '..', 'src', 'renderer');

/** The renderer's source files (not tests, not the prototype pages). */
async function sources(): Promise<{ file: string; text: string }[]> {
  const entries = await readdir(RENDERER, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && /\.tsx?$/u.test(e.name) && !/\.test\.tsx?$/u.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !f.includes(`${path.sep}lab${path.sep}`));
  return Promise.all(
    files.map(async (file) => ({
      file: path.relative(RENDERER, file).split(path.sep).join('/'),
      text: await readFile(file, 'utf8'),
    })),
  );
}

/** The `id` of every `register<Kind>({ id: '…' })` call. */
function registered(text: string, call: string): string[] {
  const pattern = new RegExp(`${call}\\(\\{\\s*id:\\s*'([^']+)'`, 'gu');
  return [...text.matchAll(pattern)].map((m) => m[1] ?? '');
}

/** Missing from the list: `found` minus `listed`. */
function missing(found: Iterable<string>, listed: Iterable<string>): string[] {
  const have = new Set(listed);
  return [...new Set(found)].filter((id) => !have.has(id)).sort();
}

describe('accessibility state list', () => {
  it('lists every settings page, panel, dialog and row kind', async () => {
    const files = await sources();
    const pages = files.flatMap((f) => registered(f.text, 'registerSettingsPage'));
    const panels = files.flatMap((f) => registered(f.text, 'registerPanel'));
    const dialogs = files.filter((f) => /<(?:Dialog|dialog)\b/u.test(f.text)).map((f) => f.file);
    expect(pages.length).toBeGreaterThan(5);
    expect(panels.length).toBeGreaterThan(5);
    expect(dialogs.length).toBeGreaterThan(5);
    const listed = (area: string, key: 'page' | 'panel' | 'source' | 'row') =>
      A11Y_STATES.filter((s) => s.area === area).map((s) =>
        String((s as Record<string, unknown>)[key]),
      );
    expect({
      settingsPages: missing(pages, listed('settings', 'page')),
      panels: missing(panels, listed('panel', 'panel')),
      dialogs: missing(dialogs, listed('dialog', 'source')),
      rows: missing(ROW_KINDS, listed('row', 'row')),
    }).toEqual({ settingsPages: [], panels: [], dialogs: [], rows: [] });
  });

  it('has unique ids', () => {
    const ids = A11Y_STATES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
