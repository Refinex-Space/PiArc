// Renderer bundle. The sources live in src/renderer; the output path must match the
// renderer name in forge.config.ts because the main process serves it from there.
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.join(import.meta.dirname, 'src', 'renderer'),
  build: {
    outDir: path.join(import.meta.dirname, '.vite', 'renderer', 'main_window'),
    emptyOutDir: true,
  },
  plugins: [react()],
});
