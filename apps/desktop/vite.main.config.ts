// Main-process bundle. @electron-forge/plugin-vite supplies the entry, the CommonJS output
// `.vite/build/main.cjs` and the externals (electron and Node built-ins).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vite';

// `__PIARC_RELEASE_BUILD__`: true only when `npm run package:desktop` packages the release flavor
// (it always sets PIARC_BUILD_FLAVOR); the development flavor, `electron-forge start` and a bare
// `vite build` (L4's dev form) keep the test pages and accept debugging switches (T45).
const RELEASE_BUILD = process.env.PIARC_BUILD_FLAVOR === 'release';

const repo = path.join(import.meta.dirname, '..', '..');

/** `field` of the JSON file at `parts` below the repository, or `unknown`. */
function versionIn(parts: readonly string[], pick: (value: unknown) => unknown): string {
  try {
    const value = pick(JSON.parse(readFileSync(path.join(repo, ...parts), 'utf8')));
    return typeof value === 'string' ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function member(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) =>
      typeof current === 'object' && current !== null && key in current
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );
}

// The About page's versions of the bundled parts (ADR-0111): Pi from the Agent Host's exact
// dependency, libghostty-vt from its lock file.
const COMPONENTS = {
  pi: versionIn(['agent-host', 'package.json'], (v) =>
    member(v, 'dependencies', '@earendil-works/pi-coding-agent'),
  ),
  ghostty: versionIn(['crates', 'piarc-ghostty-sys', 'ghostty-vt.lock.json'], (v) =>
    member(v, 'version'),
  ),
};

export default defineConfig({
  define: {
    __PIARC_RELEASE_BUILD__: JSON.stringify(RELEASE_BUILD),
    __PIARC_COMPONENTS__: JSON.stringify(COMPONENTS),
  },
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
