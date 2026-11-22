// Main-process bundle. @electron-forge/plugin-vite supplies the entry, the CommonJS output
// `.vite/build/main.cjs` and the externals (electron and Node built-ins).
import path from 'node:path';

import { defineConfig } from 'vite';

// `__PIARC_RELEASE_BUILD__`: true only when `npm run package:desktop` packages the release flavor
// (it always sets PIARC_BUILD_FLAVOR); the development flavor, `electron-forge start` and a bare
// `vite build` (L4's dev form) keep the test pages and accept debugging switches (T45).
const RELEASE_BUILD = process.env.PIARC_BUILD_FLAVOR === 'release';

export default defineConfig({
  define: { __PIARC_RELEASE_BUILD__: JSON.stringify(RELEASE_BUILD) },
  // Bundle the protocol package from source, as the Agent Host bundle does: its `dist/` exists
  // only after a `tsc --build`, which packaging does not run.
  resolve: {
    alias: {
      '@piarc/protocol': path.join(
        import.meta.dirname,
        '..',
        '..',
        'packages',
        'protocol',
        'src',
        'index.ts',
      ),
    },
  },
});
