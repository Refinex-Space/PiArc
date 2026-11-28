// Fails when the committed protocol schema or generated TypeScript differs from what
// `npm run gen:protocol` produces now: regenerates into a temporary directory and compares
// every file byte for byte, including files that should not exist.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateProtocol, listGenerated } from '../dev/gen-protocol.mjs';
import { isMain, repoRoot } from '../lib/repo.mjs';

/**
 * Compares the generated files under two roots.
 * @param {string} committedRoot the repository
 * @param {string} freshRoot a root that was just regenerated
 * @returns {Promise<{ changed: string[], missing: string[], stale: string[] }>}
 *   `missing`: generated now but not committed; `stale`: committed but no longer generated.
 */
export async function diffGenerated(committedRoot, freshRoot) {
  const committed = await listGenerated(committedRoot);
  const fresh = await listGenerated(freshRoot);
  const changed = [];
  for (const file of fresh.filter((f) => committed.includes(f))) {
    const [a, b] = await Promise.all([
      readFile(path.join(committedRoot, file)),
      readFile(path.join(freshRoot, file)),
    ]);
    if (!a.equals(b)) {
      changed.push(file);
    }
  }
  return {
    changed,
    missing: fresh.filter((f) => !committed.includes(f)),
    stale: committed.filter((f) => !fresh.includes(f)),
  };
}

async function main() {
  const freshRoot = await mkdtemp(path.join(os.tmpdir(), 'piarc-protocol-drift-'));
  try {
    await generateProtocol(freshRoot);
    const { changed, missing, stale } = await diffGenerated(repoRoot, freshRoot);
    const problems = [
      ...changed.map((f) => `  changed: ${f}`),
      ...missing.map((f) => `  missing: ${f}`),
      ...stale.map((f) => `  stale:   ${f}`),
    ];
    if (problems.length > 0) {
      console.error('Protocol drift: generated files differ from the piarc-protocol crate.');
      console.error(problems.join('\n'));
      console.error('Run `npm run gen:protocol` and commit the result.');
      process.exitCode = 1;
      return;
    }
    console.log('Protocol drift check passed: schema and generated types are up to date.');
  } finally {
    await rm(freshRoot, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  await main();
}
