// Main-process bundle. @electron-forge/plugin-vite supplies the entry, the CommonJS output
// `.vite/build/main.cjs` and the externals (electron and Node built-ins).
import path from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
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
