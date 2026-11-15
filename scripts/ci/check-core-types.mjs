// L1 snapshot of the Core API (ADR-0014 rule 6, architecture section 7.6): builds the Core
// native module for the host in both flavors and compares the TypeScript declarations
// NAPI-RS generates with the committed ones in apps/desktop/src/main/core/native/.
//
// A changed export signature without an updated snapshot fails here; `npm run build:core --
// --flavor all` updates the snapshots. The development build it leaves in
// target/piarc-core/development/ is the one the Vitest integration tests load.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DECLARATIONS_DIR, DECLARATION_FILES, buildCore } from '../dev/build-core.mjs';
import { isMain, repoRoot } from '../lib/repo.mjs';

/** @typedef {import('../../apps/desktop/fuses.mjs').BuildFlavor} BuildFlavor */

/**
 * Compares one declaration file under two directories. A missing committed file counts as
 * changed.
 * @param {string} committedDir
 * @param {string} freshDir
 * @param {string} file
 * @returns {Promise<boolean>} true when the files are byte-for-byte equal
 */
export async function sameDeclarations(committedDir, freshDir, file) {
  const fresh = await readFile(path.join(freshDir, file));
  try {
    return fresh.equals(await readFile(path.join(committedDir, file)));
  } catch {
    return false;
  }
}

async function main() {
  const freshDir = await mkdtemp(path.join(os.tmpdir(), 'piarc-core-types-'));
  try {
    const committedDir = path.join(repoRoot, DECLARATIONS_DIR);
    /** @type {string[]} */
    const changed = [];
    /** @type {BuildFlavor[]} */
    const flavors = ['release', 'development'];
    for (const flavor of flavors) {
      await buildCore({ flavor, declarationsDir: freshDir });
      const file = DECLARATION_FILES[flavor];
      if (!(await sameDeclarations(committedDir, freshDir, file))) {
        changed.push(path.join(DECLARATIONS_DIR, file));
      }
    }
    if (changed.length > 0) {
      console.error('Core API drift: the NAPI-RS declarations differ from the snapshot.');
      console.error(changed.map((file) => `  changed: ${file}`).join('\n'));
      console.error('Run `npm run build:core -- --flavor all` and commit the result.');
      process.exitCode = 1;
      return;
    }
    console.log('Core API snapshot check passed: declarations match crates/piarc-napi.');
  } finally {
    await rm(freshDir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  await main();
}
