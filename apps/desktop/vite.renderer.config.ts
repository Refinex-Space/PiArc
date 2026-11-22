// Renderer bundle. The sources live in src/renderer; the output path must match the
// renderer name in forge.config.ts because the main process serves it from there.
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `__PIARC_RELEASE_BUILD__`: true only when `npm run package:desktop` packages the release flavor
// (it always sets PIARC_BUILD_FLAVOR); the development flavor, `electron-forge start` and a bare
// `vite build` (L4's dev form) keep the test pages and accept debugging switches (T45).
const RELEASE_BUILD = process.env.PIARC_BUILD_FLAVOR === 'release';

export default defineConfig({
  define: { __PIARC_RELEASE_BUILD__: JSON.stringify(RELEASE_BUILD) },
  root: path.join(import.meta.dirname, 'src', 'renderer'),
  build: {
    outDir: path.join(import.meta.dirname, '.vite', 'renderer', 'main_window'),
    emptyOutDir: true,
  },
  plugins: [react()],
  // Bundle the protocol package from source (see vite.main.config.ts).
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
  // Workers are ES modules served from the app scheme like every other script (the CSP's
  // `script-src 'self'` covers them); the module format lets the highlight worker load each
  // grammar as its own chunk.
  worker: { format: 'es' },
});
