// The app version (docs/engineering/release.md, section 2): its single source is the
// `version` of apps/desktop/package.json (Electron's app.getVersion()), mirrored in the
// package-lock entry of the workspace; a release is the tag v<version>.
//
//   node scripts/release/version.mjs set <version> [--date YYYY-MM-DD]
//       Sets the version and moves both changelogs' Unreleased entries into a dated
//       "## [<version>]" section (the date defaults to today, UTC).
//   node scripts/release/version.mjs check [--tag v<version>]
//       Fails unless package.json and the lockfile agree, the tag (when given) names that
//       version, and both changelogs have a dated, well-formed section for it whose Security
//       subsections agree.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain, isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';
import {
  formatChangelog,
  isSecurity,
  LANGUAGES,
  parseChangelog,
  releaseUnreleased,
  sectionProblems,
  VERSION_PATTERN,
} from './changelog.mjs';

const PACKAGE_JSON = path.join(repoRoot, 'apps', 'desktop', 'package.json');
const LOCKFILE = path.join(repoRoot, 'package-lock.json');
const LOCK_KEY = 'apps/desktop';

/** @param {string} version */
export function assertVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`"${version}" is not a version (MAJOR.MINOR.PATCH[-prerelease])`);
  }
}

/**
 * Replaces the first `"version": "…"` of a JSON text, keeping its formatting.
 * @param {string} text
 * @param {string} version
 */
export function withPackageVersion(text, version) {
  const pattern = /^(\s*"version":\s*")[^"]*(")/m;
  if (!pattern.test(text)) {
    throw new Error('package.json has no "version" member');
  }
  return text.replace(pattern, `$1${version}$2`);
}

/**
 * The lockfile text with the desktop workspace's version replaced, keeping its formatting.
 * @param {string} text
 * @param {string} version
 */
export function withLockVersion(text, version) {
  const marker = `"${LOCK_KEY}": {`;
  const start = text.indexOf(marker);
  if (start === -1) {
    throw new Error(`package-lock.json has no "${LOCK_KEY}" entry`);
  }
  const rest = text.slice(start);
  const pattern = /("version":\s*")[^"]*(")/;
  const match = pattern.exec(rest);
  const end = rest.indexOf('\n    }');
  if (match === null || end === -1 || match.index > end) {
    throw new Error(`the "${LOCK_KEY}" entry of package-lock.json has no version`);
  }
  return text.slice(0, start) + rest.replace(pattern, `$1${version}$2`);
}

/** The version in apps/desktop/package.json and in the lockfile entry. */
export function readVersions() {
  const pkg = readJsonFile(PACKAGE_JSON);
  const lock = readJsonFile(LOCKFILE);
  const entry = isRecord(lock) && isRecord(lock.packages) ? lock.packages[LOCK_KEY] : undefined;
  return {
    package: isRecord(pkg) && typeof pkg.version === 'string' ? pkg.version : undefined,
    lock: isRecord(entry) && typeof entry.version === 'string' ? entry.version : undefined,
  };
}

/**
 * Problems with releasing `version`, given both changelogs' texts.
 * @param {string} version
 * @param {Record<import('./changelog.mjs').Language, string>} texts
 * @returns {string[]}
 */
export function changelogProblems(version, texts) {
  const en = parseChangelog(texts.en);
  const zh = parseChangelog(texts['zh-CN']);
  const problems = [
    ...sectionProblems(en, version, 'en'),
    ...sectionProblems(zh, version, 'zh-CN'),
  ];
  const enSection = en.sections.find((s) => s.version === version);
  const zhSection = zh.sections.find((s) => s.version === version);
  if (enSection !== undefined && zhSection !== undefined) {
    if (enSection.date !== zhSection.date) {
      problems.push(`the two changelogs date ${version} differently`);
    }
    if (isSecurity(enSection.body, 'en') !== isSecurity(zhSection.body, 'zh-CN')) {
      problems.push(
        `only one changelog marks ${version} as a security release ("### Security" / "### 安全")`,
      );
    }
  }
  return problems;
}

/** Both changelogs' texts. */
export async function readChangelogs() {
  return {
    en: await readFile(LANGUAGES.en.file, 'utf8'),
    'zh-CN': await readFile(LANGUAGES['zh-CN'].file, 'utf8'),
  };
}

/** @param {Date} now */
function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { date: { type: 'string' }, tag: { type: 'string' } },
  });
  const [command, version] = positionals;
  switch (command) {
    case 'set': {
      if (version === undefined) {
        throw new Error('usage: set <version> [--date YYYY-MM-DD]');
      }
      assertVersion(version);
      const date = values.date ?? today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`--date ${date} is not YYYY-MM-DD`);
      }
      const texts = await readChangelogs();
      const released = {
        en: formatChangelog(
          releaseUnreleased(parseChangelog(texts.en), version, date, 'CHANGELOG.md'),
        ),
        'zh-CN': formatChangelog(
          releaseUnreleased(parseChangelog(texts['zh-CN']), version, date, 'CHANGELOG.zh-CN.md'),
        ),
      };
      const problems = changelogProblems(version, released);
      if (problems.length > 0) {
        throw new Error(problems.join('\n'));
      }
      await writeFile(
        PACKAGE_JSON,
        withPackageVersion(await readFile(PACKAGE_JSON, 'utf8'), version),
      );
      await writeFile(LOCKFILE, withLockVersion(await readFile(LOCKFILE, 'utf8'), version));
      await writeFile(LANGUAGES.en.file, released.en);
      await writeFile(LANGUAGES['zh-CN'].file, released['zh-CN']);
      console.log(`version ${version} (${date}); next: commit, merge, then tag v${version}`);
      return;
    }
    case 'check': {
      const versions = readVersions();
      if (versions.package === undefined) {
        throw new Error('apps/desktop/package.json has no version');
      }
      const problems = [];
      if (versions.lock !== versions.package) {
        problems.push(
          `package-lock.json says ${String(versions.lock)}, package.json ${versions.package}`,
        );
      }
      if (!VERSION_PATTERN.test(versions.package)) {
        problems.push(`${versions.package} is not a release version`);
      }
      if (values.tag !== undefined && values.tag !== `v${versions.package}`) {
        problems.push(`tag ${values.tag} does not name version ${versions.package}`);
      }
      problems.push(...changelogProblems(versions.package, await readChangelogs()));
      if (problems.length > 0) {
        throw new Error(problems.join('\n'));
      }
      console.log(versions.package);
      return;
    }
    default:
      throw new Error('usage: version.mjs set <version> | check [--tag v<version>]');
  }
}

if (isMain(import.meta.url)) {
  await main();
}
