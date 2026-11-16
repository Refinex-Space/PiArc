// Builds Velopack installers from a packaged Windows app (ADR-0018 rule 3): per-user install,
// no UAC, not signed. Runs on Windows (CI); `vpk` comes from the nupkg locked in
// third-party/binaries.lock.json and is installed into .tools/vpk/ (no global install).
//
//   node scripts/release/pack-windows.mjs --arch x64|arm64 [--flavor development|release]
//        --versions 0.0.1,0.0.2 [--out <dir>]
//
// Each version is packed from the same packaged app into one release directory, so the
// directory is an update feed in which the later version updates the earlier one (W0 checks
// the update mechanism with it). Output: apps/desktop/out/<flavor>/velopack/win32-<arch>/.
//
// Identity: `--packId` and the shortcuts' `--aumid` are the application identifier
// (cn.piarc.desktop, the AppUserModelID the main process sets). The pack id names the install
// directory %LocalAppData%\<packId>; it must not be `PiArc`, which is PiArc's data directory
// (architecture section 9.1) and would be removed with an uninstall.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { APP_IDENTIFIER } from '../../apps/desktop/app-identity.mjs';
import { parseBuildFlavor } from '../../apps/desktop/fuses.mjs';
import { fetchArtefact, readLock } from '../dev/fetch-binaries.mjs';
import { isMain, repoRoot, run } from '../lib/repo.mjs';

const VPK_DIR = path.join(repoRoot, '.tools', 'vpk');

/**
 * Installs the locked vpk into .tools/vpk/ from the verified nupkg only (a NuGet config whose
 * single source is the cache directory), and returns its executable.
 */
export async function installVpk() {
  const version = readLock().vpk?.version;
  if (version === undefined) {
    throw new Error('third-party/binaries.lock.json has no vpk entry');
  }
  const executable = path.join(VPK_DIR, process.platform === 'win32' ? 'vpk.exe' : 'vpk');
  if (existsSync(executable)) {
    return executable;
  }
  const nupkg = await fetchArtefact('vpk', 'any');
  const config = path.join(path.dirname(nupkg), 'nuget.config');
  await writeFile(
    config,
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<configuration>',
      '  <packageSources>',
      '    <clear />',
      `    <add key="locked" value="${path.dirname(nupkg)}" />`,
      '  </packageSources>',
      '</configuration>',
      '',
    ].join('\n'),
  );
  const code = await run('dotnet', [
    'tool',
    'install',
    'vpk',
    '--version',
    version,
    '--tool-path',
    VPK_DIR,
    '--configfile',
    config,
  ]);
  if (code !== 0) {
    throw new Error(`dotnet tool install vpk ${version} failed (${String(code)})`);
  }
  return executable;
}

/**
 * Packs one version.
 * @param {{ vpk: string, packDir: string, outDir: string, arch: string, version: string }} options
 */
async function pack({ vpk, packDir, outDir, arch, version }) {
  const code = await run(vpk, [
    'pack',
    '--packId',
    APP_IDENTIFIER,
    '--packVersion',
    version,
    '--packDir',
    packDir,
    '--mainExe',
    'PiArc.exe',
    '--packTitle',
    'PiArc',
    '--packAuthors',
    'PiArc',
    '--icon',
    path.join(repoRoot, 'design', 'brand', 'icon.ico'),
    '--runtime',
    `win-${arch}`,
    '--channel',
    `win-${arch}`,
    '--aumid',
    APP_IDENTIFIER,
    '--outputDir',
    outDir,
  ]);
  if (code !== 0) {
    throw new Error(`vpk pack ${version} (${arch}) failed (${String(code)})`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      arch: { type: 'string', default: process.arch },
      flavor: { type: 'string' },
      versions: { type: 'string', default: '0.0.1' },
      out: { type: 'string' },
    },
  });
  if (values.arch !== 'x64' && values.arch !== 'arm64') {
    throw new Error(`--arch must be x64 or arm64, got ${values.arch}`);
  }
  const flavor = parseBuildFlavor(values.flavor);
  const desktopOut = path.join(repoRoot, 'apps', 'desktop', 'out', flavor);
  const packDir = path.join(desktopOut, `PiArc-win32-${values.arch}`);
  if (!existsSync(path.join(packDir, 'PiArc.exe'))) {
    throw new Error(
      `${packDir} has no PiArc.exe; run package:desktop -- --flavor ${flavor} --arch ${values.arch}`,
    );
  }
  const outDir = values.out ?? path.join(desktopOut, 'velopack', `win32-${values.arch}`);
  await mkdir(outDir, { recursive: true });
  const vpk = await installVpk();
  for (const version of values.versions.split(',').map((v) => v.trim())) {
    await pack({ vpk, packDir, outDir, arch: values.arch, version });
  }
  console.log(`Velopack releases in ${outDir}`);
}

if (isMain(import.meta.url)) {
  await main();
}
