// Packages the desktop app with Electron Forge for one build flavor and architecture.
//   node scripts/dev/package-desktop.mjs [--flavor release|development] [--arch arm64|x64] [--make]
// Release and the host architecture are the defaults. Before Forge runs, this builds what the
// app carries: the Core module of the flavor for the target (crates/piarc-napi), the Agent
// Host bundle, the bundled node, rg and fd (scripts/dev/fetch-binaries.mjs, checked
// against third-party/binaries.lock.json) and the speech runtime and models
// (scripts/dev/fetch-speech-assets.mjs, third-party/speech-assets.lock.json). Output goes to apps/desktop/out/<flavor>/;
// `--make` also builds the installers (macOS: DMG and ZIP under out/<flavor>/make/).
import path from 'node:path';
import { parseArgs } from 'node:util';

import { CORE_TARGETS } from '../../apps/desktop/core-binary.mjs';
import { parseBuildFlavor } from '../../apps/desktop/fuses.mjs';
import { isMain, repoRoot, resolveBin, run } from '../lib/repo.mjs';
import { buildAgentHost } from './build-agent-host.mjs';
import { buildCore } from './build-core.mjs';
import { stageAgentHostRuntime } from './fetch-binaries.mjs';
import { stageSpeechAssets } from './fetch-speech-assets.mjs';

/**
 * The Rust target triple of a platform and architecture, or undefined for the host.
 * @param {string} platform
 * @param {string} arch
 */
function rustTarget(platform, arch) {
  if (platform === process.platform && arch === process.arch) {
    return undefined;
  }
  const entry = Object.entries(CORE_TARGETS).find(
    ([, t]) => t.platform === platform && t.arch === arch,
  );
  if (entry === undefined) {
    throw new Error(`PiArc is not built for ${platform}-${arch}`);
  }
  return entry[0];
}

/**
 * Builds the prerequisites and runs `electron-forge package` (or `make`).
 * @param {{ flavor: import('../../apps/desktop/fuses.mjs').BuildFlavor, arch: string, make: boolean }} options
 * @returns {Promise<number>} Forge's exit code
 */
export async function packageDesktop({ flavor, arch, make }) {
  const platform = process.platform;
  console.log(`Building Core (${flavor} flavor, ${platform}-${arch})`);
  await buildCore({ flavor, target: rustTarget(platform, arch) });
  console.log('Building the Agent Host bundle');
  await buildAgentHost();
  console.log(`Staging node, rg and fd for ${platform}-${arch}`);
  await stageAgentHostRuntime(platform, arch);
  console.log(`Staging the speech runtime and models for ${platform}-${arch}`);
  await stageSpeechAssets(platform, arch);
  console.log(`${make ? 'Making' : 'Packaging'} the desktop app (${flavor} flavor, ${arch})`);
  return run(
    process.execPath,
    [
      resolveBin('@electron-forge/cli', 'electron-forge'),
      make ? 'make' : 'package',
      '--arch',
      arch,
    ],
    {
      cwd: path.join(repoRoot, 'apps', 'desktop'),
      env: { ...process.env, PIARC_BUILD_FLAVOR: flavor },
    },
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      flavor: { type: 'string' },
      arch: { type: 'string', default: process.arch },
      make: { type: 'boolean', default: false },
    },
  });
  process.exitCode = await packageDesktop({
    flavor: parseBuildFlavor(values.flavor),
    arch: values.arch,
    make: values.make,
  });
}

if (isMain(import.meta.url)) {
  await main();
}
