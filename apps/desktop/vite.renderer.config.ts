// Renderer bundle. The sources live in src/renderer; the output path must match the
// renderer name in forge.config.ts because the main process serves it from there.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const resolve = createRequire(import.meta.url).resolve;
const engineFile = resolve('mermaid/dist/mermaid.min.js');

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
  plugins: [
    react(),
    {
      name: 'local-markdown-diagrams',
      async generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'markdown-diagram/engine.js',
          source: await readFile(engineFile),
        });
        // Ship attribution with the offline bundle, including the two source-level ports.
        const licences = path.resolve(import.meta.dirname, '../../third-party/licenses');
        const documents: [string, string][] = [
          [
            'Markdown Studio (Refinex) — adapted Markdown editor and document rendering',
            path.join(licences, 'markdown-studio.LICENSE'),
          ],
          [
            'Marklyra (Refinex) — adapted editor interactions and local image validation',
            path.join(licences, 'marklyra.LICENSE'),
          ],
          ['Mermaid', path.join(path.dirname(engineFile), '../LICENSE')],
          ['KaTeX', path.join(path.dirname(resolve('katex')), '../LICENSE')],
          ['khroma', path.join(licences, 'khroma-2.1.0.LICENSE')],
          ...[
            '@codemirror/commands',
            '@codemirror/lang-markdown',
            '@codemirror/language',
            '@codemirror/language-data',
            '@codemirror/search',
            '@codemirror/state',
            '@codemirror/view',
            '@lezer/common',
            '@lezer/highlight',
            '@lezer/markdown',
          ].map((name): [string, string] => [
            name,
            path.join(path.dirname(resolve(name)), '../LICENSE'),
          ]),
        ];
        const sections = await Promise.all(
          documents.map(async ([name, file]) => name + '\n' + (await readFile(file, 'utf8'))),
        );
        this.emitFile({
          type: 'asset',
          fileName: 'markdown-notices.txt',
          source: sections.join('\n\n'),
        });
      },
      configureServer(server) {
        server.middlewares.use('/markdown-diagram/engine.js', (_req, res, next) => {
          void readFile(engineFile).then((bytes) => {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(bytes);
          }, next);
        });
      },
    },
  ],
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
