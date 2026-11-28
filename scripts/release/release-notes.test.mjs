import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildBody,
  buildNotes,
  NOTES_FORMAT,
  publicKeyLine,
  serializeNotes,
} from './release-notes.mjs';

const texts = {
  en: '# C\n\n## [Unreleased]\n\n## [1.1.0] - 2027-01-02\n\n### Fixed\n\n- A crash.\n\n### Security\n\n- Electron 46.0.1.\n',
  'zh-CN':
    '# C\n\n## [Unreleased]\n\n## [1.1.0] - 2027-01-02\n\n### 修复\n\n- 崩溃。\n\n### 安全\n\n- Electron 46.0.1。\n',
};

describe('buildNotes', () => {
  it('has exactly the members of ADR-0111 rule 2', () => {
    const notes = buildNotes('1.1.0', texts);
    expect(notes).toEqual({
      format: NOTES_FORMAT,
      version: '1.1.0',
      date: '2027-01-02',
      security: true,
      notes: {
        en: '### Fixed\n\n- A crash.\n\n### Security\n\n- Electron 46.0.1.',
        'zh-CN': '### 修复\n\n- 崩溃。\n\n### 安全\n\n- Electron 46.0.1。',
      },
    });
    /** @type {unknown} */
    const parsed = JSON.parse(serializeNotes(notes));
    expect(Object.keys(parsed ?? {})).toEqual(['format', 'version', 'date', 'security', 'notes']);
  });

  it('refuses a version without sections', () => {
    expect(() => buildNotes('2.0.0', texts)).toThrow(/no "## \[2\.0\.0\]/);
  });
});

describe('buildBody', () => {
  it('has both languages, the downloads, the security banner and the key', () => {
    const body = buildBody(buildNotes('1.1.0', texts), 'RWQ' + 'A'.repeat(53));
    expect(body).toMatch(/Security update/);
    expect(body).toContain('<summary>简体中文</summary>');
    expect(body).toContain(
      '[PiArc-1.1.0-windows-arm64-Setup.exe](https://github.com/Refinex-Space/PiArc/releases/download/v1.1.0/PiArc-1.1.0-windows-arm64-Setup.exe)',
    );
    expect(body).toContain(`minisign -Vm piarc-release-manifest.json -P RWQ${'A'.repeat(53)}`);
  });
});

describe('publicKeyLine', () => {
  it('reads a minisign public key file', () => {
    const file = path.join(import.meta.dirname, 'test-keys', 'release-manifest.test.pub');
    expect(publicKeyLine(readFileSync(file, 'utf8'))).toMatch(/^RW/);
    expect(() => publicKeyLine('untrusted comment: x\nnot a key\n')).toThrow();
  });
});
