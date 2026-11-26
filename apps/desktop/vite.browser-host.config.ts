// The agent's script host page (ADR-0089 rule 3, ADR-0091): `src/browser-host/index.html` and
// the browser SDK. The output path matches the renderer name `browser_host` in
// forge.config.ts; the main process serves it on the `piarc-browser-host:` scheme in the host's
// own partition, under a CSP that allows only its own scripts (src/main/browser/host-session.ts).
import path from 'node:path';

import { defineConfig } from 'vite';

const RELEASE_BUILD = process.env.PIARC_BUILD_FLAVOR === 'release';

export default defineConfig({
  define: { __PIARC_RELEASE_BUILD__: JSON.stringify(RELEASE_BUILD) },
  root: path.join(import.meta.dirname, 'src', 'browser-host'),
  base: '/',
  build: {
    outDir: path.join(import.meta.dirname, '.vite', 'renderer', 'browser_host'),
    emptyOutDir: true,
    // No inline polyfill: the host's CSP has no `'unsafe-inline'`.
    modulePreload: false,
  },
});
