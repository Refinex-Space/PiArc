// The Velopack binding (npm `velopack`) inside Windows builds. The main-process bundle does not
// include it: the main process loads it at run time from app.asar's node_modules, and only on
// Windows (src/main/platform/velopack.ts). This copies the JavaScript files and the one native
// module of the target architecture there; plugin-auto-unpack-natives moves the `.node` out of
// the archive. macOS builds get nothing (ADR-0018: no Velopack on macOS).
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Native module of the binding for each Windows architecture. */
const NATIVE = Object.freeze({
  x64: 'velopack_nodeffi_win_x64_msvc.node',
  arm64: 'velopack_nodeffi_win_arm64_msvc.node',
});

/**
 * @param {{ repoRoot: string, buildPath: string, arch: string }} options `buildPath` is the
 *   app directory that becomes app.asar
 */
export async function copyVelopackRuntime({ repoRoot, buildPath, arch }) {
  const native = arch === 'x64' || arch === 'arm64' ? NATIVE[arch] : undefined;
  if (native === undefined) {
    throw new Error(`no Velopack binding for win32-${arch}`);
  }
  const from = path.join(repoRoot, 'node_modules');
  const to = path.join(buildPath, 'node_modules');
  const velopack = path.join(to, 'velopack');
  await mkdir(path.join(velopack, 'lib', 'native'), { recursive: true });
  await cp(path.join(from, 'velopack', 'package.json'), path.join(velopack, 'package.json'));
  for (const file of ['index.js', 'load.js', 'types.js']) {
    await cp(path.join(from, 'velopack', 'lib', file), path.join(velopack, 'lib', file));
  }
  await cp(
    path.join(from, 'velopack', 'lib', 'native', native),
    path.join(velopack, 'lib', 'native', native),
  );
  const neon = path.join(to, '@neon-rs', 'load');
  await mkdir(path.join(neon, 'dist'), { recursive: true });
  await cp(path.join(from, '@neon-rs', 'load', 'package.json'), path.join(neon, 'package.json'));
  await cp(
    path.join(from, '@neon-rs', 'load', 'dist', 'index.js'),
    path.join(neon, 'dist', 'index.js'),
  );
}
