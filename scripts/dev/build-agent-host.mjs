// Builds the Agent Host as local ESM chunks for Node (architecture section 5.6):
// agent-host/dist/bundle/agent-host.mjs, plus pi-assets/ (Pi's package.json, which Pi reads
// for its version and config directory name; Core points PI_PACKAGE_DIR at it).
//
// Usage: npm run build:agent-host (node scripts/dev/build-agent-host.mjs)
//
// Build options follow Pi's own bundle (reference/pi scripts/build-coding-agent-bundle.mjs,
// v1.5.2, MIT): ESM, node22.19, the `createRequire` banner for bundled CommonJS code,
// `PI_BUNDLED_NODE`, and photon-node left external because it loads its wasm file from its
// package directory. Everything else is inlined; the build fails if any other package stays
// external. The list of externals is documented in agent-host/AGENTS.md.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import {
  BUNDLE_MANIFEST,
  CHUNK_DIR,
  CHUNK_NAME,
  digest,
  entrySource,
} from '../../apps/desktop/packaging/agent-bundle.mjs';
import { isMain, repoRoot } from '../lib/repo.mjs';

/** Packages left external, each because Pi loads a native or wasm asset next to it. */
export const EXTERNAL_PACKAGES = ['@silvia-odwyer/photon-node'];

/** Packages that are optional at runtime: their importers catch the failed import. */
const OPTIONAL_PACKAGES = new Set(['bufferutil', 'utf-8-validate', 'kerberos', 'supports-color']);

export const BUNDLE_DIR = path.join(repoRoot, 'agent-host', 'dist', 'bundle');
export const BUNDLE_FILE = path.join(BUNDLE_DIR, 'agent-host.mjs');
export const PI_ASSETS_DIR = path.join(BUNDLE_DIR, 'pi-assets');

/** Builds the bundle and returns its path. */
export async function buildAgentHost() {
  mkdirSync(path.join(BUNDLE_DIR, CHUNK_DIR), { recursive: true });
  const staging = mkdtempSync(path.join(BUNDLE_DIR, '.build-'));
  try {
    return await buildInto(staging);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Publish a complete file on the same volume; an already published identical file can stay
 * open (including on Windows).
 * @param {string} staged
 * @param {string} target
 */
function publish(staged, target) {
  const same = () => existsSync(target) && readFileSync(staged).equals(readFileSync(target));
  if (same()) return;
  try {
    renameSync(staged, target);
  } catch (error) {
    if (!same()) throw error;
  }
}

/** @param {string} staging */
async function buildInto(staging) {
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, 'agent-host', 'src', 'main.ts')],
    outdir: staging,
    outExtension: { '.js': '.mjs' },
    entryNames: 'entry-[hash]',
    chunkNames: 'chunk-[hash]',
    splitting: true,
    minifySyntax: true,
    minifyWhitespace: true,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.19',
    banner: {
      js: 'import { createRequire as __piarcCreateRequire } from "node:module"; const require = __piarcCreateRequire(import.meta.url);',
    },
    define: { PI_BUNDLED_NODE: 'true' },
    // Bundle the protocol package from source, so the bundle does not depend on a prior
    // `tsc --build` of packages/protocol (Rust tests build the bundle on their own).
    alias: { '@piarc/protocol': path.join(repoRoot, 'packages', 'protocol', 'src', 'index.ts') },
    external: [...EXTERNAL_PACKAGES, ...OPTIONAL_PACKAGES],
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
    sourcemap: false,
  });
  const unexpected = new Set();
  for (const input of Object.values(result.metafile.inputs)) {
    for (const imported of input.imports) {
      if (
        imported.external &&
        !isBuiltin(imported.path) &&
        !EXTERNAL_PACKAGES.includes(imported.path) &&
        !OPTIONAL_PACKAGES.has(imported.path)
      ) {
        unexpected.add(imported.path);
      }
    }
  }
  if (unexpected.size > 0) {
    throw new Error(
      `bundle left unexpected external imports: ${[...unexpected].sort().join(', ')}`,
    );
  }
  // The package is ESM-only and does not export package.json: resolve its entry (dist/index.js)
  // and step up to the package root.
  const piEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const piPackageJson = path.join(path.dirname(path.dirname(piEntry)), 'package.json');
  mkdirSync(PI_ASSETS_DIR, { recursive: true });
  writeFileSync(path.join(staging, 'package.json'), readFileSync(piPackageJson));
  publish(path.join(staging, 'package.json'), path.join(PI_ASSETS_DIR, 'package.json'));

  publishModules(staging, Object.keys(result.metafile.outputs));
  return BUNDLE_FILE;
}

/** @param {string} staging @param {string[]} outputs */
function publishModules(staging, outputs) {
  // Publish the immutable modules first. Hosts which are running during a rebuild may still
  // import an older chunk later; packaging copies only the manifest's current generation.
  /** @type {Record<string, string>} */
  const files = {};
  let entry;
  for (const output of outputs.sort()) {
    const name = path.basename(output);
    if (!CHUNK_NAME.test(name)) throw new Error(`Unexpected Agent Host build output: ${name}`);
    const file = path.join(staging, name);
    files[name] = digest(readFileSync(file));
    publish(file, path.join(BUNDLE_DIR, CHUNK_DIR, name));
    if (name.startsWith('entry-')) {
      if (entry !== undefined) throw new Error('esbuild emitted two Agent Host entries');
      entry = name;
    }
  }
  if (entry === undefined) throw new Error('esbuild did not emit an Agent Host entry');
  writeFileSync(path.join(staging, BUNDLE_MANIFEST), JSON.stringify({ entry, files }) + '\n');
  publish(path.join(staging, BUNDLE_MANIFEST), path.join(BUNDLE_DIR, BUNDLE_MANIFEST));
  const loader = path.join(staging, 'agent-host.mjs');
  writeFileSync(loader, entrySource(entry));
  publish(loader, BUNDLE_FILE);
}

if (isMain(import.meta.url)) {
  const file = await buildAgentHost();
  console.log(`built ${path.relative(repoRoot, file)}`);
}
