// The Agent Host resources of a packaged app (architecture section 5.6, ADR-0015): one
// directory next to app.asar, outside the archive because the bundled Node cannot read asar.
//
//   Resources/agent-host/
//   ├── node/                 Node.js (macOS: bin/node, bin/npm, bin/npx, lib/node_modules/npm;
//   │                         Windows: node.exe, npm(.cmd), npx(.cmd), node_modules/npm)
//   ├── agent-host.mjs        the bundle (scripts/dev/build-agent-host.mjs)
//   ├── pi-assets/            PI_PACKAGE_DIR
//   ├── node_modules/         the bundle's external packages (agent-host/CLAUDE.md)
//   └── bin/                  rg, fd (`.exe` on Windows)
//
// Core resolves the same relative paths at run time (`piarc_core::agent_host::BundledRuntime`);
// scripts/ci/check-app-layout.mjs checks a packaged app against them.
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { keepInNodeRuntime } from './trim.mjs';

/** Directory name under the app's resources directory. */
export const AGENT_HOST_DIR = 'agent-host';

/** Packages the bundle imports at run time (EXTERNAL_PACKAGES of build-agent-host.mjs). */
export const AGENT_HOST_EXTERNALS = Object.freeze(['@silvia-odwyer/photon-node']);

/**
 * Paths inside `Resources/agent-host/`, relative and with the platform's separators.
 * @param {string} platform
 */
export function agentHostLayout(platform) {
  const exe = platform === 'win32' ? '.exe' : '';
  const nodeBin = platform === 'win32' ? 'node' : path.join('node', 'bin');
  return Object.freeze({
    node: path.join(nodeBin, `node${exe}`),
    npm: path.join(nodeBin, platform === 'win32' ? 'npm.cmd' : 'npm'),
    npx: path.join(nodeBin, platform === 'win32' ? 'npx.cmd' : 'npx'),
    nodeBin,
    bundle: 'agent-host.mjs',
    piAssets: 'pi-assets',
    piPackageJson: path.join('pi-assets', 'package.json'),
    nodeModules: 'node_modules',
    toolsBin: 'bin',
    rg: path.join('bin', `rg${exe}`),
    fd: path.join('bin', `fd${exe}`),
  });
}

/**
 * The resources directory of a packaged app inside Forge's output directory.
 * @param {string} outputPath `out/<flavor>/<name>-<platform>-<arch>`
 * @param {string} platform
 * @param {string} appName
 */
export function resourcesDirOf(outputPath, platform, appName) {
  return platform === 'darwin'
    ? path.join(outputPath, `${appName}.app`, 'Contents', 'Resources')
    : path.join(outputPath, 'resources');
}

/**
 * Copies the Agent Host resources into `resourcesDir/agent-host/`: the runtime staged by
 * scripts/dev/fetch-binaries.mjs, the bundle and pi-assets from build-agent-host.mjs, and the
 * bundle's external packages from node_modules.
 * @param {{ repoRoot: string, resourcesDir: string, platform: string, arch: string }} options
 * @returns {Promise<string>} the agent-host directory
 */
export async function copyAgentHostResources({ repoRoot, resourcesDir, platform, arch }) {
  const runtime = path.join(repoRoot, 'target', 'agent-host-runtime', `${platform}-${arch}`);
  const bundleDir = path.join(repoRoot, 'agent-host', 'dist', 'bundle');
  const layout = agentHostLayout(platform);
  const missing = [
    [path.join(runtime, layout.node), 'node scripts/dev/fetch-binaries.mjs'],
    [path.join(runtime, layout.rg), 'node scripts/dev/fetch-binaries.mjs'],
    [path.join(bundleDir, layout.bundle), 'npm run build:agent-host'],
    [path.join(bundleDir, layout.piPackageJson), 'npm run build:agent-host'],
  ].filter(([file]) => file !== undefined && !existsSync(file));
  if (missing.length > 0) {
    const lines = missing.map(([file, fix]) => `  ${String(file)} (run \`${String(fix)}\`)`);
    throw new Error(
      `Agent Host resources for ${platform}-${arch} are missing:\n${lines.join('\n')}\n` +
        'package-desktop.mjs prepares them; run it instead of electron-forge directly.',
    );
  }
  const target = path.join(resourcesDir, AGENT_HOST_DIR);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  // `verbatimSymlinks` keeps npm's bin links (bin/npm → ../lib/node_modules/npm/bin/npm-cli.js)
  // relative, so they still resolve inside the app.
  await cp(path.join(runtime, 'node'), path.join(target, 'node'), {
    recursive: true,
    verbatimSymlinks: true,
    // Without npm's docs and man pages (packaging/trim.mjs, I41).
    filter: keepInNodeRuntime,
  });
  await cp(path.join(runtime, 'bin'), path.join(target, layout.toolsBin), { recursive: true });
  await cp(path.join(bundleDir, layout.bundle), path.join(target, layout.bundle));
  await cp(path.join(bundleDir, layout.piAssets), path.join(target, layout.piAssets), {
    recursive: true,
  });
  for (const name of AGENT_HOST_EXTERNALS) {
    await cp(
      path.join(repoRoot, 'node_modules', name),
      path.join(target, layout.nodeModules, name),
      { recursive: true },
    );
  }
  return target;
}
