// Electron Forge configuration. `PIARC_BUILD_FLAVOR` selects the fuse settings
// (`release` by default, or `development`) and the Core build that is packaged; use
// `npm run package:desktop` from the repository root rather than setting it by hand.
// Output goes to `out/<flavor>/`.
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

import { coreBinaryName, coreBuildDir } from './core-binary.mjs';
import { fuseSettingsFor, parseBuildFlavor, toFuseConfig } from './fuses.mjs';

const flavor = parseBuildFlavor(process.env.PIARC_BUILD_FLAVOR);
const repoRoot = path.join(import.meta.dirname, '..', '..');

/**
 * Copies the Core module of this flavor into the app as `native/<name>`. The main process
 * loads it from app.asar.unpacked/native/ (src/main/core/native-path.ts).
 */
async function copyCoreModule(buildPath: string, platform: string, arch: string): Promise<void> {
  const name = coreBinaryName(platform, arch);
  const source = path.join(coreBuildDir(repoRoot, flavor), name);
  if (!existsSync(source)) {
    throw new Error(
      `Core module ${source} is missing. Run \`npm run build:core -- --flavor ${flavor}\` ` +
        '(add --target <triple> for another architecture).',
    );
  }
  const destination = path.join(buildPath, 'native', name);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

const config: ForgeConfig = {
  outDir: path.join('out', flavor),
  packagerConfig: {
    // Required by OnlyLoadAppFromAsar and ASAR integrity validation.
    asar: true,
  },
  rebuildConfig: {},
  makers: [],
  hooks: {
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => {
      await copyCoreModule(buildPath, platform, arch);
    },
  },
  plugins: [
    // Keeps every .node file out of app.asar (in app.asar.unpacked), so Core is loaded from
    // a real file and never reads from the archive (ADR-0014 rule 7).
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      // The name is also the output directory `.vite/renderer/main_window` (see
      // vite.renderer.config.ts) and the value of MAIN_WINDOW_VITE_NAME in the main process.
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin(toFuseConfig(fuseSettingsFor(flavor))),
  ],
};

export default config;
