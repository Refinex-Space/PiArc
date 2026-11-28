// Locating and launching the two forms of the app. All platform-specific paths of L4 tests are
// resolved here.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** `dev`: Electron from node_modules on .vite/; `packaged`: the development-flavor package. */
export type AppForm = 'dev' | 'packaged';

/** apps/desktop */
export const desktopDir = path.join(import.meta.dirname, '..');

const PACKAGE_HINT =
  'Run `npm run package:desktop -- --flavor development` from the repository root first.';

function productName(): string {
  const manifest: unknown = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'productName' in manifest &&
    typeof manifest.productName === 'string'
  ) {
    return manifest.productName;
  }
  throw new Error('apps/desktop/package.json has no productName');
}

/** Executable of the development-flavor package for the current platform and architecture. */
export function packagedExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const name = productName();
  const appDir = path.join(desktopDir, 'out', 'development', `${name}-${platform}-${arch}`);
  switch (platform) {
    case 'darwin':
      return path.join(appDir, `${name}.app`, 'Contents', 'MacOS', name);
    case 'win32':
      return path.join(appDir, `${name}.exe`);
    default:
      return path.join(appDir, name);
  }
}

function electronBinary(): string {
  // In Node, the `electron` package exports the path of the Electron executable.
  const binary: unknown = createRequire(import.meta.url)('electron');
  if (typeof binary !== 'string') {
    throw new Error('The electron package did not resolve to an executable path');
  }
  return binary;
}

/** The command that starts `form` with `args`; used for Playwright and for plain spawns. */
export function appCommand(
  form: AppForm,
  args: readonly string[],
): { command: string; args: string[] } {
  if (form === 'dev') {
    const required = [
      path.join(desktopDir, '.vite', 'build', 'main.cjs'),
      path.join(desktopDir, '.vite', 'renderer', 'main_window', 'index.html'),
    ];
    // `electron-forge start` wipes .vite/renderer, so its presence means the last build was a
    // production build.
    const missing = required.filter((file) => !existsSync(file));
    if (missing.length > 0) {
      throw new Error(`Production bundle not found (${missing.join(', ')}). ${PACKAGE_HINT}`);
    }
    return { command: electronBinary(), args: [desktopDir, ...args] };
  }
  const executable = packagedExecutable();
  if (!existsSync(executable)) {
    throw new Error(`Packaged app not found at ${executable}. ${PACKAGE_HINT}`);
  }
  return { command: executable, args: [...args] };
}
