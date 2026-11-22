// THR-08 (T45): the supply-chain rules of AGENTS.md and architecture section 13.3 as checks on
// the repository itself: exact versions, CI installs without scripts, a review step for new
// dependencies in the pull request template.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { isRecord, readJsonFile, repoRoot } from '../lib/repo.mjs';

const EXACT = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const MANIFESTS = [
  'package.json',
  'apps/desktop/package.json',
  'agent-host/package.json',
  'packages/protocol/package.json',
  'packages/testkit/package.json',
];

/** @param {string} relative */
function read(relative) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

/**
 * `[section]` tables of a Cargo manifest as name → lines (dotted dependency tables included).
 * @param {string} toml
 */
function tables(toml) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  let current = '';
  for (const line of toml.split('\n')) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line.trim());
    if (header !== null) {
      current = header[1] ?? '';
      out.set(current, []);
    } else if (line.trim() !== '' && !line.trim().startsWith('#')) {
      out.get(current)?.push(line.trim());
    }
  }
  return out;
}

describe('supply chain (THR-08)', () => {
  it('THR-08 every npm dependency is pinned to an exact version', () => {
    /** @type {string[]} */
    const loose = [];
    for (const manifest of MANIFESTS) {
      const json = readJsonFile(path.join(repoRoot, manifest));
      if (!isRecord(json)) throw new Error(`${manifest} is not an object`);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const deps = json[field];
        if (!isRecord(deps)) continue;
        for (const [name, version] of Object.entries(deps)) {
          const workspace = typeof version === 'string' && /^\*$|^workspace:/.test(version);
          if (!workspace && (typeof version !== 'string' || !EXACT.test(version))) {
            loose.push(`${manifest} ${field}.${name}: ${String(version)}`);
          }
        }
      }
    }
    expect(loose).toEqual([]);
  });

  it('THR-08 Cargo dependencies are declared once in the workspace with exact versions', () => {
    const root = tables(read('Cargo.toml'));
    const workspace = root.get('workspace.dependencies') ?? [];
    expect(workspace.length).toBeGreaterThan(0);
    const inexact = workspace.filter((line) => {
      if (/\bpath\s*=/.test(line)) return false;
      const version = /^[\w-]+\s*=\s*(?:"([^"]*)"|\{[^}]*\bversion\s*=\s*"([^"]*)")/.exec(line);
      const value = version?.[1] ?? version?.[2];
      return value === undefined || !/^=[0-9]+\.[0-9]+\.[0-9]+/.test(value);
    });
    expect(inexact).toEqual([]);
    /** @type {string[]} */
    const local = [];
    for (const crate of readdirSync(path.join(repoRoot, 'crates'), { withFileTypes: true })) {
      if (!crate.isDirectory()) continue;
      const file = path.join('crates', crate.name, 'Cargo.toml');
      for (const [name, lines] of tables(read(file))) {
        if (!/(^|\.)(dev-|build-)?dependencies$/.test(name)) continue;
        // Only lines that start an entry (`name = …`); a multi-line feature list continues one.
        for (const line of lines.filter((l) => /^[\w-]+(\.workspace)?\s*=/.test(l))) {
          if (!/(^[\w-]+\.workspace\s*=\s*true)|(\bworkspace\s*=\s*true\b)/.test(line)) {
            local.push(`${file} [${name}] ${line}`);
          }
        }
      }
    }
    expect(local).toEqual([]);
  });

  it('THR-08 every CI install of the dependencies runs without install scripts', () => {
    const dir = path.join(repoRoot, '.github', 'workflows');
    /** @type {string[]} */
    const unsafe = [];
    let installs = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      /** @type {unknown} */
      const workflow = parse(readFileSync(path.join(dir, file), 'utf8'));
      const jobs = isRecord(workflow) && isRecord(workflow.jobs) ? workflow.jobs : {};
      for (const [job, spec] of Object.entries(jobs)) {
        const steps = isRecord(spec) && Array.isArray(spec.steps) ? spec.steps : [];
        for (const step of steps) {
          const script = isRecord(step) && typeof step.run === 'string' ? step.run : '';
          for (const line of script.split('\n')) {
            if (!/\bnpm\s+(ci|install|i)\b/.test(line)) continue;
            // A pinned tool installed globally for a nightly job is not the repository's tree.
            if (/\s(--global|-g)\s/.test(` ${line} `) && /@\$\{?\w+\}?"?\s*$|@[0-9]/.test(line)) {
              continue;
            }
            installs += 1;
            if (!line.includes('--ignore-scripts')) unsafe.push(`${file} ${job}: ${line.trim()}`);
          }
        }
      }
    }
    expect(installs).toBeGreaterThan(0);
    expect(unsafe).toEqual([]);
  });

  it('THR-08 the pull request template asks for a review of new dependencies and their sources', () => {
    const template = read('.github/pull_request_template.md');
    for (const marker of ['dependency-review', 'source-and-license', 'threat-map']) {
      expect(template).toContain(`<!-- ${marker} -->`);
    }
  });
});
