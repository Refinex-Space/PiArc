// Shared helpers for repository scripts: repo root, entry-point detection,
// cross-platform process spawning and npm bin resolution.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Absolute path of the repository root. */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * True when the module with the given `import.meta.url` is the process entry point.
 * @param {string} moduleUrl
 */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === moduleUrl;
}

/**
 * Runs a command with inherited stdio and resolves with its exit code.
 * Arguments are passed as an array; no shell is involved, so nothing is
 * re-parsed on any platform.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<number>}
 */
export function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(`Failed to start ${command}: ${error.message}`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

/**
 * Runs a command and captures stdout as UTF-8. Rejects when the command fails.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<string>}
 */
export function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on('data', /** @param {Buffer} chunk */ (chunk) => out.push(chunk));
    child.stderr.on('data', /** @param {Buffer} chunk */ (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
      } else {
        const stderr = Buffer.concat(err).toString('utf8').trim();
        reject(new Error(`${command} ${args.join(' ')} exited with ${String(code)}\n${stderr}`));
      }
    });
  });
}

/**
 * Reads and parses a JSON file. The result is `unknown`; callers narrow it.
 * @param {string} filePath
 * @returns {unknown}
 */
export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Narrows a value to a plain object with string keys.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));

/**
 * Resolves the JavaScript entry of an npm package binary installed in the
 * repository, so it can be run as `node <entry>` without a shell. This avoids
 * the `.cmd` shims npm creates on Windows.
 * @param {string} packageName
 * @param {string} [binName] defaults to the package name
 */
export function resolveBin(packageName, binName = packageName) {
  const manifestPath = requireFromRoot.resolve(`${packageName}/package.json`);
  const manifest = readJsonFile(manifestPath);
  const bin = isRecord(manifest) ? manifest.bin : undefined;
  const relative = typeof bin === 'string' ? bin : isRecord(bin) ? bin[binName] : undefined;
  if (typeof relative !== 'string') {
    throw new Error(`Package ${packageName} has no binary named ${binName}`);
  }
  return path.join(path.dirname(manifestPath), relative);
}
