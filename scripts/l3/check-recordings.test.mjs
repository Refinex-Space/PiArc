import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../lib/repo.mjs';
import { checkRecording, checkRecordings, isProse } from './check-recordings.mjs';

const fixtures = path.join(repoRoot, 'scripts', 'l3', 'fixtures', 'recordings');
const script = path.join(repoRoot, 'scripts', 'l3', 'check-recordings.mjs');

/** @param {string} name @returns {unknown} */
const load = (name) => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));

/** @param {string} file */
const cli = (file) =>
  spawnSync(process.execPath, [script, path.join(fixtures, file)], { encoding: 'utf8' });

describe('check-recordings (T30-A05)', () => {
  it('passes a recording that holds only the whitelisted structure', () => {
    expect(checkRecording(load('normal.json'))).toEqual([]);
    const run = cli('normal.json');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('recording check passed');
  });

  it('fails a recording that carries prompt text', () => {
    const problems = checkRecording(load('with-prompt-text.json'));
    expect(problems.some((p) => p.startsWith('not in the whitelist: /requests/0/structure'))).toBe(
      true,
    );
    expect(problems).toContainEqual(
      expect.stringMatching(
        /^prompt-like text at \/requests\/0\/structure\/system\/0\/text: \d+ characters/,
      ),
    );
    const run = cli('with-prompt-text.json');
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('prompt-like text');
  });

  it('fails a parameter description inside a tool schema, which the schema leaves open', () => {
    const problems = checkRecording(load('with-parameter-description.json'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^prompt-like text at \/requests\/0\/structure\/tools\/0\/input_schema\/properties\/command\/description: \d+ characters/,
    );
  });

  it('reports every file of a directory and counts them', () => {
    const { files, problems } = checkRecordings([fixtures]);
    expect(files).toBe(3);
    expect(problems.every((p) => !p.includes('normal.json'))).toBe(true);
    expect(problems.some((p) => p.includes('with-prompt-text.json'))).toBe(true);
  });

  it('tells prose from identifiers, paths and commands', () => {
    expect(isProse('git push origin main')).toBe(false);
    expect(isProse('awk NR==1 notes.txt && git push origin main')).toBe(false);
    expect(isProse('<WS>/work space 工作区/secrets/key.txt')).toBe(false);
    expect(isProse('sha256:0123456789abcdef')).toBe(false);
    expect(isProse('Use this tool to read a file from the local filesystem when asked.')).toBe(
      true,
    );
    expect(isProse('x'.repeat(161))).toBe(true);
  });
});
