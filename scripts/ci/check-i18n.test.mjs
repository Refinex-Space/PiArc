import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { catalogProblems, i18nProblems, shown, sourceProblems } from './check-i18n.mjs';
import { repoRoot } from '../lib/repo.mjs';

/** A stand-in for intl-messageformat: `{a}` arguments and `{n, plural, one {…} other {…}}`. */
class Format {
  /** @param {string} message */
  constructor(message) {
    if (message.includes('{{')) throw new Error('bad syntax');
    this.message = message;
  }

  getAst() {
    const plural = /\{(\w+), plural, (.*)\}/u.exec(this.message);
    if (plural !== null) {
      /** @type {Record<string, { value: unknown[] }>} */
      const options = {};
      for (const m of (plural[2] ?? '').matchAll(/(=?\w+) \{[^}]*\}/gu)) {
        options[m[1] ?? ''] = { value: [] };
      }
      return [{ type: 6, value: plural[1], options }];
    }
    return [...this.message.matchAll(/\{(\w+)\}/gu)].map((m) => ({ type: 1, value: m[1] }));
  }
}

const file = path.join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'X.tsx');

describe('check-i18n', () => {
  it('reports missing keys, bad ICU, different placeholders and plural categories', () => {
    const problems = catalogProblems(
      {
        en: new Map([
          ['a', 'Hello {name}'],
          ['b', 'Bye'],
          ['c', '{count, plural, one {# file} other {# files}}'],
          ['d', 'Broken {{'],
        ]),
        'zh-CN': new Map([
          ['a', '你好 {who}'],
          ['c', '{count, plural, one {# 个} other {# 个}}'],
          ['d', '坏'],
        ]),
      },
      Format,
    );
    expect(problems).toEqual([
      'zh-CN: missing b',
      expect.stringContaining('en: d is not valid ICU'),
      'a: placeholders differ between languages ({name} and {who})',
      'zh-CN: c uses the plural category "one", which zh-CN does not have',
    ]);
  });

  it('finds hard-coded text and unknown keys, and honors exemptions and message ids', () => {
    const keys = new Set(['ok.key']);
    const source = [
      'export const A = () => <p title="Hello">Plain text</p>;',
      "export const B = () => <p>{t('missing.key')}{t('ok.key')}</p>;",
      'export const C = () => <Field label="ok.key" />;',
      '// i18n-exempt: the product name',
      'export const D = () => <h1>PiArc</h1>;',
      "export const E = () => <span aria-hidden>▸ {'…'}</span>;",
      'export const F = (n: number) => <span>{n.toLocaleString()}{n.toLocaleString(locale)}</span>;',
    ].join('\n');
    expect(sourceProblems(file, source, keys, 'renderer')).toEqual([
      'apps/desktop/src/renderer/X.tsx:1: hard-coded title "Hello"',
      'apps/desktop/src/renderer/X.tsx:1: hard-coded text "Plain text"',
      "apps/desktop/src/renderer/X.tsx:2: t('missing.key') names no message",
      "apps/desktop/src/renderer/X.tsx:7: toLocaleString() formats in the system's language; use the app's locale",
    ]);
    const main =
      "dialog.showMessageBox({ message: 'Quit now?', buttons: ['Quit', t.t('ok.key')] });";
    expect(sourceProblems(file.replace('.tsx', '.ts'), main, keys, 'main')).toEqual([
      'apps/desktop/src/renderer/X.ts:1: hard-coded message "Quit now?"',
      'apps/desktop/src/renderer/X.ts:1: hard-coded buttons "Quit"',
    ]);
  });

  it('passes on the repository', async () => {
    expect(await i18nProblems()).toEqual([]);
  });
});

describe('shown', () => {
  const at = (/** @type {string} */ relative) =>
    path.join(repoRoot, 'apps', 'desktop', ...relative.split('/'));

  it('checks the files that name rows and approval cards for screen readers (R5)', () => {
    expect(shown(at('src/renderer/transcript/row-label.ts'))).toBe(true);
    expect(shown(at('src/renderer/approvals/approval-label.ts'))).toBe(true);
  });

  it('leaves out the test pages and their helpers', () => {
    expect(shown(at('src/renderer/lab/TranscriptLab.tsx'))).toBe(false);
    expect(shown(at('src/renderer/terminal/TerminalLab.tsx'))).toBe(false);
    expect(shown(at('src/renderer/terminal/terminal-lab.ts'))).toBe(false);
  });
});
