// Compare the shipped English prompt with the local clean-room corpus. The reference is
// data only: none of its code is loaded, and no reference text or matching words are logged.
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

import { capture, repoRoot } from '../lib/repo.mjs';

const width = 10;

/** Render all tool guidance, including tools available on just one platform, from source. */
function render() {
  const bundled = buildSync({
    stdin: {
      contents: `
        import { assembleSystem } from './agent-host/src/harness/prompts/system.ts';
        import { CANONICAL_TOOLS, DEFAULT_PROFILE } from './agent-host/src/tools/profile.ts';
        process.stdout.write(assembleSystem(CANONICAL_TOOLS, DEFAULT_PROFILE, [],
          {cwd: '', platform: '', date: '', gitStatus: ''}).text);`,
      resolveDir: repoRoot,
    },
    platform: 'node',
    bundle: true,
    write: false,
  });
  const source = bundled.outputFiles[0];
  if (!source) throw new Error('Could not build the PiArc prompt');
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    input: source.contents,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('Could not render the PiArc prompt');
  return result.stdout;
}

/** @param {string} text */
function words(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: m[0].toLowerCase(),
    index: m.index,
  }));
}

async function main() {
  const prompt = render();
  const tokens = words(prompt);
  if (tokens.length < width) throw new Error('PiArc prompt is too short to compare');
  /** @type {Map<string, number[]>} */
  const starts = new Map();
  for (let i = 0; i <= tokens.length - width; i++) {
    const first = tokens[i];
    if (first) starts.set(first.word, [...(starts.get(first.word) ?? []), i]);
  }
  const root = path.join(repoRoot, 'reference', 'claude-code');
  const tracked = await capture('git', ['-C', root, 'ls-files', '-z']);
  /** @type {Set<number>} */
  const hits = new Set();
  let files = 0;
  for (const name of tracked.split('\0').filter(Boolean)) {
    const file = path.join(root, name);
    if (!lstatSync(file).isFile()) continue;
    const bytes = readFileSync(file);
    if (bytes.includes(0) || !isUtf8(bytes)) continue;
    files++;
    const reference = words(bytes.toString('utf8').replace(/\\[nrt]/g, ' '));
    for (let j = 0; j <= reference.length - width; j++) {
      for (const i of starts.get(reference[j]?.word ?? '') ?? []) {
        let n = 1;
        while (n < width && tokens[i + n]?.word === reference[j + n]?.word) n++;
        if (n === width) hits.add(i);
      }
    }
  }
  if (files === 0) throw new Error('Reference corpus contains no tracked UTF-8 text');
  console.log(
    `referenceFiles=${String(files)} promptWords=${String(tokens.length)} window=${String(width)} matchingWindows=${String(hits.size)}`,
  );
  for (const i of [...hits].sort((a, b) => a - b)) {
    const lines = prompt.slice(0, tokens[i]?.index).split('\n');
    console.log(
      `PiArc rendered prompt line ${String(lines.length)}, column ${String((lines.at(-1)?.length ?? 0) + 1)}`,
    );
  }
  if (hits.size) process.exitCode = 1;
}

await main();
