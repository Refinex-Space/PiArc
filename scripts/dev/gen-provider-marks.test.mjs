import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../lib/repo.mjs';
import { OUTPUT, generateProviderMarks, parseMark, vendoredMarks } from './gen-provider-marks.mjs';

describe('gen-provider-marks', () => {
  it('the committed module matches the vendored marks', async () => {
    const committed = await readFile(path.join(repoRoot, OUTPUT), 'utf8');
    expect(committed).toBe(await generateProviderMarks());
  });

  it('every vendored mark is a mono mark drawn in currentColor', () => {
    const marks = vendoredMarks();
    expect(marks.length).toBeGreaterThan(30);
    for (const { name, svg } of marks) {
      expect(svg, name).toContain('fill="currentColor"');
      expect(svg, name).not.toMatch(/fill="#/);
    }
  });

  it('reads paths, rules and opacity', () => {
    const mark = parseMark(
      't',
      '<svg fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24"><title>T</title>' +
        '<path d="M0 0h1" fill-opacity=".4"></path><path clip-rule="evenodd" d="M1 1h1"/></svg>',
    );
    expect(mark).toEqual({
      viewBox: '0 0 24 24',
      fillRule: 'evenodd',
      paths: [
        { d: 'M0 0h1', fillOpacity: 0.4 },
        { d: 'M1 1h1', clipRule: 'evenodd' },
      ],
    });
  });

  it('refuses what it cannot draw instead of dropping it', () => {
    const wrap = (/** @type {string} */ inner) =>
      `<svg viewBox="0 0 24 24" fill="currentColor">${inner}</svg>`;
    expect(() => parseMark('t', wrap('<circle r="1"/>'))).toThrow(/unsupported content/);
    expect(() => parseMark('t', wrap('<path d="M0 0" fill="#f00"/>'))).toThrow(/attribute fill/);
    expect(() => parseMark('t', wrap('<path d="M0 0" onclick="x"/>'))).toThrow(/attribute/);
    expect(() =>
      parseMark('t', '<svg viewBox="0 0 24 24" fill="#000"><path d="M0 0"/></svg>'),
    ).toThrow(/not currentColor/);
    expect(() => parseMark('t', wrap(''))).toThrow(/no paths/);
  });
});
