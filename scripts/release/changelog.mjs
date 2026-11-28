// The two changelogs (docs/engineering/release.md, section 3): CHANGELOG.md in English and
// CHANGELOG.zh-CN.md in Simplified Chinese, in the Keep a Changelog 1.1 layout. Both have the
// same version headings; the subsections use each language's names. A version with a
// Security subsection ("### Security", "### 安全") is a security release (ADR-0018 rule 8,
// ADR-0111 rule 2).
//
// Used by version.mjs (moving Unreleased into a dated version, checking a tag) and
// release-notes.mjs (the in-app release notes and the GitHub release body).
import path from 'node:path';

import { repoRoot } from '../lib/repo.mjs';

/** The repository the compare links point at. */
export const REPO_URL = 'https://github.com/Refinex-Space/PiArc';

/** SemVer with an optional prerelease (no build metadata: tags and file names carry it). */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/**
 * The changelog files and the subsection names each accepts, in Keep a Changelog's order.
 * The last name of each list is the Security subsection.
 */
export const LANGUAGES = /** @type {const} */ ({
  en: {
    file: path.join(repoRoot, 'CHANGELOG.md'),
    subsections: ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'],
  },
  'zh-CN': {
    file: path.join(repoRoot, 'CHANGELOG.zh-CN.md'),
    subsections: ['新增', '变更', '弃用', '移除', '修复', '安全'],
  },
});

/** @typedef {keyof typeof LANGUAGES} Language */
/** @typedef {{ version: string, date: string | undefined, body: string }} Section */
/** @typedef {{ head: string, sections: Section[], links: string[] }} Changelog */

const SECTION = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const LINK = /^\[[^\]]+\]: \S+$/;

/**
 * Splits a changelog into the text before the first version, the version sections (newest
 * first, as written) and the link references at the end.
 * @param {string} text
 * @returns {Changelog}
 */
export function parseChangelog(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  /** @type {string[]} */
  const head = [];
  /** @type {Section[]} */
  const sections = [];
  /** @type {string[]} */
  const links = [];
  /** @type {{ version: string, date: string | undefined, lines: string[] } | undefined} */
  let current;
  const close = () => {
    if (current !== undefined) {
      sections.push({
        version: current.version,
        date: current.date,
        body: current.lines.join('\n').trim(),
      });
    }
  };
  for (const line of lines) {
    const header = SECTION.exec(line);
    if (header !== null) {
      close();
      current = { version: header[1] ?? '', date: header[2], lines: [] };
    } else if (LINK.test(line)) {
      links.push(line);
    } else if (current === undefined) {
      head.push(line);
    } else {
      current.lines.push(line);
    }
  }
  close();
  return { head: head.join('\n').trim(), sections, links };
}

/** @param {Changelog} changelog */
export function formatChangelog(changelog) {
  const parts = [changelog.head];
  for (const section of changelog.sections) {
    const title =
      section.date === undefined
        ? `## [${section.version}]`
        : `## [${section.version}] - ${section.date}`;
    parts.push(section.body === '' ? title : `${title}\n\n${section.body}`);
  }
  if (changelog.links.length > 0) {
    parts.push(changelog.links.join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * The subsection names (`### …`) of a section body.
 * @param {string} body
 */
export function subsectionsOf(body) {
  return body
    .split('\n')
    .filter((line) => line.startsWith('### '))
    .map((line) => line.slice(4).trim());
}

/**
 * Problems with one version section of `language`'s changelog: missing, undated, empty,
 * unknown or repeated subsections.
 * @param {Changelog} changelog
 * @param {string} version
 * @param {Language} language
 * @returns {string[]}
 */
export function sectionProblems(changelog, version, language) {
  const name = path.basename(LANGUAGES[language].file);
  const section = changelog.sections.find((s) => s.version === version);
  if (section === undefined) {
    return [`${name} has no "## [${version}] - YYYY-MM-DD" section`];
  }
  /** @type {string[]} */
  const problems = [];
  if (section.date === undefined) {
    problems.push(`${name}: the ${version} section has no date`);
  }
  const allowed = /** @type {readonly string[]} */ (LANGUAGES[language].subsections);
  const found = subsectionsOf(section.body);
  if (found.length === 0) {
    problems.push(`${name}: the ${version} section has no "### …" subsection`);
  }
  for (const subsection of found) {
    if (!allowed.includes(subsection)) {
      problems.push(
        `${name}: "### ${subsection}" in ${version} is not one of ${allowed.join(', ')}`,
      );
    }
  }
  if (new Set(found).size !== found.length) {
    problems.push(`${name}: a subsection of ${version} appears twice`);
  }
  if (!/^\s*[-*] \S/m.test(section.body)) {
    problems.push(`${name}: the ${version} section has no entries`);
  }
  return problems;
}

/**
 * Whether a section body has the Security subsection of `language`.
 * @param {string} body
 * @param {Language} language
 */
export function isSecurity(body, language) {
  const security = LANGUAGES[language].subsections.at(-1);
  return subsectionsOf(body).includes(security ?? '');
}

/**
 * Moves the Unreleased entries into a new `## [version] - date` section, leaves an empty
 * Unreleased on top and updates the compare links.
 * @param {Changelog} changelog
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 * @param {string} fileName for messages
 * @returns {Changelog}
 */
export function releaseUnreleased(changelog, version, date, fileName) {
  if (changelog.sections.some((s) => s.version === version)) {
    throw new Error(`${fileName} already has a ${version} section; versions are never reused`);
  }
  const unreleased = changelog.sections.find((s) => s.version === 'Unreleased');
  if (unreleased === undefined || unreleased.body === '') {
    throw new Error(`${fileName}: "## [Unreleased]" is missing or empty; write the entries first`);
  }
  const previous = changelog.sections.find(
    (s) => s.version !== 'Unreleased' && s.date !== undefined,
  );
  const sections = [
    { version: 'Unreleased', date: undefined, body: '' },
    { version, date, body: unreleased.body },
    ...changelog.sections.filter((s) => s.version !== 'Unreleased'),
  ];
  const links = changelog.links.filter(
    (l) => !l.startsWith('[Unreleased]: ') && !l.startsWith(`[${version}]: `),
  );
  links.unshift(
    `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD`,
    previous === undefined
      ? `[${version}]: ${REPO_URL}/releases/tag/v${version}`
      : `[${version}]: ${REPO_URL}/compare/v${previous.version}...v${version}`,
  );
  return { head: changelog.head, sections, links };
}
