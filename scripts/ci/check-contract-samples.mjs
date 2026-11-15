// Checks that every contract in packages/protocol/schema/contracts.json (every method
// message and top-level message type exported from piarc-protocol) has L1 samples:
// at least one valid sample in tests/contracts/<name>/ and one counter-example in
// tests/contracts/<name>/invalid/. Also reports sample files that belong to no contract
// (for example a misspelled directory). tests/contracts/framing/ holds the frame codec
// cases and is not a contract.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isMain, isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';

export const CONTRACTS_FILE = path.join('packages', 'protocol', 'schema', 'contracts.json');
export const SAMPLES_DIR = path.join('tests', 'contracts');
const FRAMING_DIR = 'framing';

/**
 * Reads the contract names from contracts.json.
 * @param {string} file
 * @returns {string[]}
 */
export function readContractNames(file) {
  const registry = readJsonFile(file);
  const contracts = isRecord(registry) ? registry.contracts : undefined;
  if (!Array.isArray(contracts)) {
    throw new Error(`${file} has no contracts array`);
  }
  return contracts.map((entry) => {
    const name = isRecord(entry) ? entry.name : undefined;
    if (typeof name !== 'string') {
      throw new Error(`${file} has a contract without a name`);
    }
    return name;
  });
}

/**
 * Number of `*.json` files directly inside `dir` (0 if it does not exist).
 * @param {string} dir
 */
function countSamples(dir) {
  if (!existsSync(dir)) {
    return 0;
  }
  return readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.json'),
  ).length;
}

/**
 * Every directory under `root` that directly contains `*.json` files, as a `/`-separated
 * path relative to `root`.
 * @param {string} root
 * @param {string} [prefix]
 * @returns {string[]}
 */
function sampleDirs(root, prefix = '') {
  const dir = path.join(root, ...prefix.split('/').filter(Boolean));
  if (!existsSync(dir)) {
    return [];
  }
  /** @type {string[]} */
  const found = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  if (prefix !== '' && entries.some((e) => e.isFile() && e.name.endsWith('.json'))) {
    found.push(prefix);
  }
  for (const entry of entries.filter((e) => e.isDirectory())) {
    found.push(...sampleDirs(root, prefix === '' ? entry.name : `${prefix}/${entry.name}`));
  }
  return found;
}

/**
 * Lists problems with the samples for `contracts` under `samplesRoot`.
 * @param {readonly string[]} contracts contract names, `/`-separated
 * @param {string} samplesRoot
 * @returns {string[]}
 */
export function findSampleProblems(contracts, samplesRoot) {
  const problems = [];
  for (const name of contracts) {
    const dir = path.join(samplesRoot, ...name.split('/'));
    if (countSamples(dir) === 0) {
      problems.push(`${name}: no valid sample in tests/contracts/${name}/`);
    }
    if (countSamples(path.join(dir, 'invalid')) === 0) {
      problems.push(`${name}: no counter-example in tests/contracts/${name}/invalid/`);
    }
  }
  const known = new Set(contracts.flatMap((name) => [name, `${name}/invalid`]));
  for (const dir of sampleDirs(samplesRoot)) {
    if (!known.has(dir) && dir !== FRAMING_DIR && !dir.startsWith(`${FRAMING_DIR}/`)) {
      problems.push(`tests/contracts/${dir}/: samples belong to no contract`);
    }
  }
  return problems;
}

function main() {
  const contracts = readContractNames(path.join(repoRoot, CONTRACTS_FILE));
  const problems = findSampleProblems(contracts, path.join(repoRoot, SAMPLES_DIR));
  if (problems.length > 0) {
    console.error('Contract sample check failed:');
    console.error(problems.map((p) => `  ${p}`).join('\n'));
    console.error(
      'See docs/engineering/testing.md section 7 (L1) for how to add a protocol message.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Contract sample check passed: ${String(contracts.length)} contracts have samples.`);
}

if (isMain(import.meta.url)) {
  main();
}
