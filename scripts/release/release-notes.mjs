// Release notes of one version (ADR-0111 rule 2), from the same section of both changelogs:
//
//   node scripts/release/release-notes.mjs --version <v> --notes <piarc-release-notes.json>
//        [--body <release-body.md>] [--pub <minisign public key>]
//
// `--notes` is the release artefact the app downloads (listed in the signed manifest);
// `--body` is the GitHub release text (both languages, the downloads and how to verify them)
// and is not an artefact. `--pub` puts the release public key into the verification steps.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { isMain } from '../lib/repo.mjs';
import { isSecurity, parseChangelog, REPO_URL } from './changelog.mjs';
import { assertVersion, changelogProblems, readChangelogs } from './version.mjs';

/** Value of the notes file's `format` member. */
export const NOTES_FORMAT = 'piarc-release-notes/1';

/**
 * @typedef {{ format: string, version: string, date: string, security: boolean,
 *   notes: { en: string, 'zh-CN': string } }} ReleaseNotes
 */

/**
 * The notes of `version`.
 * @param {string} version
 * @param {Record<import('./changelog.mjs').Language, string>} texts both changelogs
 * @returns {ReleaseNotes}
 */
export function buildNotes(version, texts) {
  assertVersion(version);
  const problems = changelogProblems(version, texts);
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
  const en = parseChangelog(texts.en).sections.find((s) => s.version === version);
  const zh = parseChangelog(texts['zh-CN']).sections.find((s) => s.version === version);
  if (en?.date === undefined || zh === undefined) {
    throw new Error(`no dated ${version} section`);
  }
  return {
    format: NOTES_FORMAT,
    version,
    date: en.date,
    security: isSecurity(en.body, 'en'),
    notes: { en: en.body, 'zh-CN': zh.body },
  };
}

/** @param {ReleaseNotes} notes */
export function serializeNotes(notes) {
  return `${JSON.stringify(notes, null, 2)}\n`;
}

/**
 * The artefact names of `version` (ADR-0111 rule 1) that people download by hand.
 * @param {string} version
 * @returns {[platform: string, name: string][]}
 */
export function downloadsOf(version) {
  return [
    ['macOS, Apple silicon', `PiArc-${version}-macos-arm64.dmg`],
    ['macOS, Intel', `PiArc-${version}-macos-x64.dmg`],
    ['Windows x64', `PiArc-${version}-windows-x64-Setup.exe`],
    ['Windows arm64', `PiArc-${version}-windows-arm64-Setup.exe`],
  ];
}

/**
 * The GitHub release text.
 * @param {ReleaseNotes} notes
 * @param {string | undefined} publicKey the minisign public key's base64 line
 */
export function buildBody(notes, publicKey) {
  const { version } = notes;
  const base = `${REPO_URL}/releases/download/v${version}`;
  const lines = [];
  if (notes.security) {
    lines.push(
      '> [!IMPORTANT]',
      '> **Security update.** Please update as soon as possible. / **安全更新**，请尽快更新。',
      '',
    );
  }
  lines.push(
    notes.notes.en,
    '',
    '<details>',
    '<summary>简体中文</summary>',
    '',
    notes.notes['zh-CN'],
    '',
    '</details>',
    '',
    '## Downloads',
    '',
    '| Platform | File |',
    '|---|---|',
    ...downloadsOf(version).map(
      ([platform, name]) => `| ${platform} | [${name}](${base}/${name}) |`,
    ),
    '',
    'PiArc is not signed by Apple or Microsoft: see [First launch](' +
      `${REPO_URL}#download) for how to open it the first time. ` +
      'Installed copies update themselves from **Settings → About**.',
    '',
    '## Verifying downloads',
    '',
    '`piarc-release-manifest.json` lists the size and SHA-256 of every file in this release and ' +
      'is signed with the project key (`piarc-release-manifest.json.minisig`). PiArc checks both ' +
      'before it installs an update. To check a download yourself with ' +
      '[minisign](https://jedisct1.github.io/minisign/):',
    '',
    '```sh',
    publicKey === undefined
      ? 'minisign -Vm piarc-release-manifest.json -p piarc-release.pub'
      : `minisign -Vm piarc-release-manifest.json -P ${publicKey}`,
    `shasum -a 256 PiArc-${version}-macos-arm64.dmg   # Windows: certutil -hashfile <file> SHA256`,
    '```',
    '',
    'and compare the hash with the file’s entry in the manifest.',
    '',
  );
  return lines.join('\n');
}

/**
 * The base64 line of a minisign public key file.
 * @param {string} text
 */
export function publicKeyLine(text) {
  const line = text.split(/\r?\n/)[1]?.trim() ?? '';
  if (!/^[A-Za-z0-9+/]{56}$/.test(line)) {
    throw new Error('not a minisign public key file');
  }
  return line;
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      notes: { type: 'string' },
      body: { type: 'string' },
      pub: { type: 'string' },
    },
  });
  if (values.version === undefined || values.notes === undefined) {
    throw new Error('usage: --version <v> --notes <file> [--body <file>] [--pub <file>]');
  }
  const notes = buildNotes(values.version, await readChangelogs());
  await writeFile(values.notes, serializeNotes(notes));
  if (values.body !== undefined) {
    const key =
      values.pub === undefined ? undefined : publicKeyLine(await readFile(values.pub, 'utf8'));
    await writeFile(values.body, buildBody(notes, key));
  }
  console.log(`notes of ${values.version}${notes.security ? ' (security release)' : ''} written`);
}

if (isMain(import.meta.url)) {
  await main();
}
