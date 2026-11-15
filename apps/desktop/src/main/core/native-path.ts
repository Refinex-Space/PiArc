// The one place that decides which Core native module the main process loads (ADR-0014).
//
// - Development (`electron .` on the source tree, `electron-forge start`): the development
//   build that `npm run build:core` leaves in target/piarc-core/development/.
// - Packaged: the module forge.config.ts copied into the app, which
//   @electron-forge/plugin-auto-unpack-natives keeps out of app.asar. It is loaded from
//   app.asar.unpacked/ directly: Core must never read files inside the asar (Electron 45
//   rejects asar file descriptors passed to native code with EBADF).
//
// The file name follows @napi-rs/cli's `--platform` naming, like apps/desktop/core-binary.mjs
// does for the build scripts; both are tested against the same names.
import path from 'node:path';

/** Directory inside the packaged app (and app.asar.unpacked) that holds the module. */
export const PACKAGED_NATIVE_DIR = 'native';

/** What the resolution depends on; the main process passes Electron's values. */
export interface CoreModuleLocation {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** `app.getAppPath()`: apps/desktop in development, `…/app.asar` when packaged. */
  readonly appPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

/** `piarc-core.darwin-arm64.node`, `piarc-core.win32-x64-msvc.node`, … */
export function coreModuleName(platform: NodeJS.Platform, arch: string): string {
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`PiArc Core is not built for architecture ${arch}`);
  }
  switch (platform) {
    case 'darwin':
      return `piarc-core.darwin-${arch}.node`;
    case 'win32':
      return `piarc-core.win32-${arch}-msvc.node`;
    default:
      throw new Error(`PiArc Core is not built for platform ${platform}`);
  }
}

/** Absolute path of the Core module to load. */
export function resolveCoreModulePath(location: CoreModuleLocation): string {
  const name = coreModuleName(location.platform, location.arch);
  if (location.isPackaged) {
    return path.join(
      path.dirname(location.appPath),
      `${path.basename(location.appPath)}.unpacked`,
      PACKAGED_NATIVE_DIR,
      name,
    );
  }
  return path.join(location.appPath, '..', '..', 'target', 'piarc-core', 'development', name);
}
