import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSampleProblems } from './check-contract-samples.mjs';

/** @type {string[]} */
const roots = [];

/**
 * Creates a samples root (path with a space and Chinese characters) with the given files.
 * @param {string[]} files `/`-separated paths relative to the root
 */
function makeRoot(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'samples 样本-'));
  roots.push(root);
  for (const file of files) {
    const full = path.join(root, ...file.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, '{}\n');
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('findSampleProblems', () => {
  it('passes when every contract has a sample and a counter-example', () => {
    const root = makeRoot([
      'host/hello/hello.json',
      'host/hello/invalid/missing-protocol.json',
      'item/agentMessage/delta/delta.json',
      'item/agentMessage/delta/invalid/missing-delta.json',
      'framing/decode.json',
    ]);
    expect(findSampleProblems(['host/hello', 'item/agentMessage/delta'], root)).toEqual([]);
  });

  it('names the contract that has no samples', () => {
    const root = makeRoot(['host/hello/hello.json', 'host/hello/invalid/bad.json']);
    expect(findSampleProblems(['host/hello', 'turn/aborted'], root)).toEqual([
      'turn/aborted: no valid sample in tests/contracts/turn/aborted/',
      'turn/aborted: no counter-example in tests/contracts/turn/aborted/invalid/',
    ]);
  });

  it('requires a counter-example besides the valid sample', () => {
    const root = makeRoot(['host/hello/hello.json']);
    expect(findSampleProblems(['host/hello'], root)).toEqual([
      'host/hello: no counter-example in tests/contracts/host/hello/invalid/',
    ]);
  });

  it('reports samples that belong to no contract', () => {
    const root = makeRoot([
      'host/hello/hello.json',
      'host/hello/invalid/bad.json',
      'host/helo/typo.json',
    ]);
    expect(findSampleProblems(['host/hello'], root)).toEqual([
      'tests/contracts/host/helo/: samples belong to no contract',
    ]);
  });
});
