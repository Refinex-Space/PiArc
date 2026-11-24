// The dependency audit (T45, THR-08; `npm run audit:deps`, CI workflow deps-security.yml):
//
// 1. `npm audit --json` over the whole lockfile (all workspaces, the Agent Host bundle's
//    dependencies included): high and critical advisories fail unless
//    tests/security/audit-exceptions.yaml covers them; lower ones are listed;
// 2. cargo-audit over Cargo.lock (`.tools/bin/cargo-audit`, `node scripts/dev/install-tools.mjs`):
//    every vulnerability fails unless excepted;
// 3. cargo-deny's advisories and licenses checks (deny.toml), as in verify step 11;
// 4. the licenses of the npm packages that ship (not dev-only) against NPM_LICENSES.
//
// Expired exceptions fail (review them); exceptions that match nothing are listed for removal.
// Needs the network (advisory databases). Exit code 1 on any blocking problem.
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  NPM_LICENSES,
  cargoFindings,
  judge,
  npmFindings,
  npmLicenseProblems,
  parseExceptions,
} from '../lib/audit.mjs';
import { isMain, isRecord, readJsonFile, repoRoot, run } from '../lib/repo.mjs';
import { localToolPath } from '../dev/install-tools.mjs';

/**
 * An npm tarball can omit its SPDX field while shipping a licence. Accept a reviewed
 * declaration only for the pinned archive and the complete, byte-identical licence file.
 * @param {unknown} sources
 * @param {string} root
 */
export function reviewedNpmLicenses(sources, root) {
  const entries =
    isRecord(sources) && Array.isArray(sources.components)
      ? sources.components.filter(isRecord)
      : [];
  /** @param {string} location @param {Record<string,unknown>} pkg */
  return (location, pkg) => {
    const name = location.split('node_modules/').at(-1);
    for (const entry of entries) {
      const npm = entry.npm;
      if (
        !isRecord(npm) ||
        npm.package !== name ||
        entry.version !== pkg.version ||
        typeof pkg.integrity !== 'string' ||
        npm.integrity !== pkg.integrity ||
        typeof npm.licenseFile !== 'string' ||
        typeof entry.licenseFile !== 'string' ||
        typeof entry.license !== 'string'
      )
        continue;
      const installed = path.join(root, location, npm.licenseFile);
      if (
        existsSync(installed) &&
        readFileSync(installed).equals(readFileSync(path.join(root, entry.licenseFile)))
      )
        return entry.license;
    }
    return '';
  };
}
export const EXCEPTIONS = path.join(repoRoot, 'tests', 'security', 'audit-exceptions.yaml');

/**
 * Runs a command and returns its stdout whatever the exit code (audits exit non-zero when they
 * find something).
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function output(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on('data', /** @param {Buffer} chunk */ (chunk) => out.push(chunk));
    child.stderr.on('data', /** @param {Buffer} chunk */ (chunk) => err.push(chunk));
    child.on('error', (error) => {
      resolve({ code: 127, stdout: '', stderr: error.message });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/**
 * npm's own JavaScript entry, run with this Node (no shell, no `.cmd` shim on Windows): the one
 * `npm run` started us with, else the npm installed beside Node.
 */
function npmCli() {
  const fromRun = process.env.npm_execpath;
  if (fromRun !== undefined && fromRun.endsWith('.js') && existsSync(fromRun)) return fromRun;
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) throw new Error(`npm not found beside ${process.execPath}`);
  return found;
}

/** @param {string} name */
function tool(name) {
  const local = localToolPath(name);
  return existsSync(local) ? local : name;
}

/**
 * @param {string} label
 * @param {{ stdout: string, stderr: string }} result
 * @returns {unknown}
 */
function json(label, result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not print JSON:\n${result.stderr.trim()}`);
  }
}

/** @param {import('../lib/audit.mjs').Finding} f */
function line(f) {
  return `${f.ecosystem} ${f.id} ${f.package} (${f.severity}): ${f.title}`;
}

async function main() {
  /** @type {string[]} */
  const failures = [];
  const { exceptions, problems } = parseExceptions(readFileSync(EXCEPTIONS, 'utf8'));
  failures.push(...problems);

  console.log('· npm audit (all workspaces, dev and production)');
  const npm = await output(process.execPath, [npmCli(), 'audit', '--json']);
  const npmList = npmFindings(json('npm audit', npm));
  const prod = await output(process.execPath, [npmCli(), 'audit', '--json', '--omit=dev']);
  const prodList = npmFindings(json('npm audit --omit=dev', prod));
  console.log(
    `  ${String(npmList.length)} advisories (${String(prodList.length)} in production dependencies)`,
  );

  console.log('· cargo-audit (Cargo.lock)');
  const cargo = await output(tool('cargo-audit'), ['audit', '--json', '--file', 'Cargo.lock']);
  if (cargo.code === 127) {
    failures.push('cargo-audit was not found; install it with: node scripts/dev/install-tools.mjs');
  }
  const cargoList = cargo.code === 127 ? [] : cargoFindings(json('cargo audit', cargo));
  console.log(`  ${String(cargoList.length)} vulnerabilities`);

  const today = new Date().toISOString().slice(0, 10);
  const verdict = judge([...npmList, ...cargoList], exceptions, today);
  for (const f of verdict.excepted) console.log(`  excepted: ${line(f)}`);
  for (const f of verdict.reported) console.log(`  reported (below high): ${line(f)}`);
  for (const f of verdict.blocking) failures.push(`unhandled advisory: ${line(f)}`);
  for (const e of verdict.expired) {
    failures.push(
      `exception ${e.ecosystem} ${e.id} (${e.package}) passed its review date ${e.reviewBy}`,
    );
  }
  for (const e of verdict.unused) {
    console.log(`  exception ${e.ecosystem} ${e.id} (${e.package}) matches nothing: remove it`);
  }

  console.log('· cargo-deny (advisories, licenses)');
  const deny = await run(tool('cargo-deny'), ['check', 'advisories', 'licenses']);
  if (deny !== 0)
    failures.push(`cargo-deny check advisories licenses failed (exit ${String(deny)})`);

  console.log('· npm licenses (packages that ship)');
  const licenses = npmLicenseProblems(
    readJsonFile(path.join(repoRoot, 'package-lock.json')),
    NPM_LICENSES,
    reviewedNpmLicenses(readJsonFile(path.join(repoRoot, 'third-party/sources.json')), repoRoot),
  );
  console.log(`  ${String(licenses.checked)} packages checked`);
  failures.push(...licenses.problems.map((p) => `license outside the allowlist: ${p}`));

  for (const failure of failures) console.error(`✖ ${failure}`);
  if (failures.length > 0) {
    console.error(`${String(failures.length)} problem(s).`);
    process.exitCode = 1;
  } else {
    console.log('dependency audit passed');
  }
}

if (isMain(import.meta.url)) {
  await main();
}
