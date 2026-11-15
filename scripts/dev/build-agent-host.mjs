// Bundles the Agent Host into one ESM file for Node (architecture section 5.6):
// agent-host/dist/bundle/agent-host.mjs, plus pi-assets/ (Pi's package.json, which Pi reads
// for its version and config directory name; Core points PI_PACKAGE_DIR at it).
//
// Usage: npm run build:agent-host (node scripts/dev/build-agent-host.mjs)
//
// Build options follow Pi's own bundle (reference/pi scripts/build-coding-agent-bundle.mjs,
// v1.5.2, MIT): ESM, node22.19, the `createRequire` banner for bundled CommonJS code,
// `PI_BUNDLED_NODE`, and photon-node left external because it loads its wasm file from its
// package directory. Everything else is inlined; the build fails if any other package stays
// external. The list of externals is documented in agent-host/CLAUDE.md.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

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
  rmSync(BUNDLE_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, 'agent-host', 'src', 'main.ts')],
    outfile: BUNDLE_FILE,
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
  cpSync(piPackageJson, path.join(PI_ASSETS_DIR, 'package.json'));
  return BUNDLE_FILE;
}

if (isMain(import.meta.url)) {
  const file = await buildAgentHost();
  console.log(`built ${path.relative(repoRoot, file)}`);
}
