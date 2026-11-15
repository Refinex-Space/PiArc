// Electron Forge configuration. `PIARC_BUILD_FLAVOR` selects the fuse settings
// (`release` by default, or `development`); use `npm run package:desktop` from the
// repository root rather than setting it by hand. Output goes to `out/<flavor>/`.
import path from 'node:path';

import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

import { fuseSettingsFor, parseBuildFlavor, toFuseConfig } from './fuses.mjs';

const flavor = parseBuildFlavor(process.env.PIARC_BUILD_FLAVOR);

const config: ForgeConfig = {
  outDir: path.join('out', flavor),
  packagerConfig: {
    // Required by OnlyLoadAppFromAsar and ASAR integrity validation.
    asar: true,
  },
  rebuildConfig: {},
  makers: [],
  plugins: [
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
