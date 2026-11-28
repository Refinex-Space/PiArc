import { describe, expect, it } from 'vitest';

import {
  formatChangelog,
  isSecurity,
  parseChangelog,
  releaseUnreleased,
  sectionProblems,
} from './changelog.mjs';

const EN = `# Changelog

Notes.

## [Unreleased]

### Added

- A thing.

## [1.0.0] - 2026-12-01

### Added

- First release.

[Unreleased]: https://github.com/Refinex-Space/PiArc/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Refinex-Space/PiArc/releases/tag/v1.0.0
`;

describe('parseChangelog / formatChangelog', () => {
  it('splits head, sections and links and writes them back unchanged', () => {
    const parsed = parseChangelog(EN);
    expect(parsed.head).toBe('# Changelog\n\nNotes.');
    expect(parsed.sections.map((s) => [s.version, s.date])).toEqual([
      ['Unreleased', undefined],
      ['1.0.0', '2026-12-01'],
    ]);
    expect(parsed.links).toHaveLength(2);
    expect(formatChangelog(parsed)).toBe(EN);
  });

  it('reads CRLF text', () => {
    expect(parseChangelog(EN.replace(/\n/g, '\r\n')).sections).toHaveLength(2);
  });
});

describe('releaseUnreleased', () => {
  it('moves the entries into a dated section and links the comparison with the previous version', () => {
    const next = releaseUnreleased(parseChangelog(EN), '1.1.0', '2027-01-02', 'CHANGELOG.md');
    expect(next.sections.map((s) => [s.version, s.date, s.body])).toEqual([
      ['Unreleased', undefined, ''],
      ['1.1.0', '2027-01-02', '### Added\n\n- A thing.'],
      ['1.0.0', '2026-12-01', '### Added\n\n- First release.'],
    ]);
    expect(next.links.slice(0, 2)).toEqual([
      '[Unreleased]: https://github.com/Refinex-Space/PiArc/compare/v1.1.0...HEAD',
      '[1.1.0]: https://github.com/Refinex-Space/PiArc/compare/v1.0.0...v1.1.0',
    ]);
    expect(formatChangelog(next)).toContain('## [Unreleased]\n\n## [1.1.0] - 2027-01-02\n');
  });

  it('links the first release to its tag', () => {
    const first = parseChangelog('# C\n\n## [Unreleased]\n\n### Added\n\n- x\n');
    const next = releaseUnreleased(first, '1.0.0', '2026-12-01', 'CHANGELOG.md');
    expect(next.links).toEqual([
      '[Unreleased]: https://github.com/Refinex-Space/PiArc/compare/v1.0.0...HEAD',
      '[1.0.0]: https://github.com/Refinex-Space/PiArc/releases/tag/v1.0.0',
    ]);
  });

  it('refuses an existing version and an empty Unreleased', () => {
    expect(() => releaseUnreleased(parseChangelog(EN), '1.0.0', '2027-01-01', 'C')).toThrow(
      /never reused/,
    );
    const empty = parseChangelog('# C\n\n## [Unreleased]\n');
    expect(() => releaseUnreleased(empty, '1.0.0', '2027-01-01', 'C')).toThrow(/empty/);
  });
});

describe('sectionProblems', () => {
  it('accepts a dated section with known subsections and entries', () => {
    expect(sectionProblems(parseChangelog(EN), '1.0.0', 'en')).toEqual([]);
  });

  it('reports a missing section, a missing date, unknown subsections and no entries', () => {
    const bad = parseChangelog('# C\n\n## [2.0.0]\n\n### Neu\n\nText.\n');
    expect(sectionProblems(bad, '3.0.0', 'en')).toEqual([
      'CHANGELOG.md has no "## [3.0.0] - YYYY-MM-DD" section',
    ]);
    const problems = sectionProblems(bad, '2.0.0', 'zh-CN');
    expect(problems.join('\n')).toMatch(/no date/);
    expect(problems.join('\n')).toMatch(/"### Neu"/);
    expect(problems.join('\n')).toMatch(/no entries/);
  });
});

describe('isSecurity', () => {
  it('is the Security subsection of each language', () => {
    expect(isSecurity('### Fixed\n\n- a\n\n### Security\n\n- b', 'en')).toBe(true);
    expect(isSecurity('### 修复\n\n- a', 'zh-CN')).toBe(false);
    expect(isSecurity('### 安全\n\n- b', 'zh-CN')).toBe(true);
    expect(isSecurity('Security fixes inside a line', 'en')).toBe(false);
  });
});
