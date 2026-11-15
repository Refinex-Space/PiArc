// Installs pinned Rust developer tools into `<repo>/.tools` instead of the
// global cargo bin directory. `verify.mjs` looks there first.
//
// Usage: node scripts/dev/install-tools.mjs
import { existsSync } from 'node:fs';
import path from 'node:path';
import { capture, isMain, repoRoot, run } from '../lib/repo.mjs';

/**
 * Pinned tool versions. CI caches `.tools` keyed on this file. ripgrep and fd serve Pi's native
 * grep and find tools in the behavior comparison test (T07, `crates/piarc-testkit/tests/
 * agent_host/parity.rs`); PiArc's own Grep and Glob run in Core and need neither. bindgen-cli
 * regenerates the libghostty-vt bindings (`scripts/dev/gen-ghostty-bindings.mjs`, T10); it
 * loads libclang at run time (Xcode command line tools on macOS).
 */
export const TOOLS = [
  { crate: 'cargo-deny', version: '0.20.2', bin: 'cargo-deny' },
  { crate: 'ripgrep', version: '15.2.0', bin: 'rg' },
  { crate: 'fd-find', version: '10.5.0', bin: 'fd' },
  { crate: 'bindgen-cli', version: '0.73.2', bin: 'bindgen' },
];

export const toolsRoot = path.join(repoRoot, '.tools');

/**
 * Path of a tool binary inside `.tools/bin`, with the platform executable suffix.
 * @param {string} bin
 */
export function localToolPath(bin) {
  const file = process.platform === 'win32' ? `${bin}.exe` : bin;
  return path.join(toolsRoot, 'bin', file);
}

/**
 * True when the binary exists and reports the pinned version.
 * @param {string} binPath
 * @param {string} version
 */
async function hasVersion(binPath, version) {
  if (!existsSync(binPath)) {
    return false;
  }
  try {
    const out = await capture(binPath, ['--version']);
    return out.includes(version);
  } catch {
    return false;
  }
}

async function main() {
  let failed = false;
  for (const tool of TOOLS) {
    const binPath = localToolPath(tool.bin);
    if (await hasVersion(binPath, tool.version)) {
      console.log(`${tool.crate} ${tool.version} already installed in ${toolsRoot}`);
      continue;
    }
    console.log(`Installing ${tool.crate} ${tool.version} into ${toolsRoot}`);
    const code = await run('cargo', [
      'install',
      '--locked',
      '--root',
      toolsRoot,
      '--version',
      tool.version,
      tool.crate,
    ]);
    if (code !== 0) {
      console.error(`Installing ${tool.crate} failed with exit code ${String(code)}`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  await main();
}
