// Electron Forge configuration. `PIARC_BUILD_FLAVOR` selects the fuse settings
// (`release` by default, or `development`) and the Core build that is packaged; use
// `npm run package:desktop` from the repository root rather than setting it by hand.
// Output goes to `out/<flavor>/`. Packaging also copies the Agent Host resources next to
// app.asar (packaging/agent-host-layout.mjs) and, on macOS, redoes the ad-hoc signatures in
// layers (packaging/macos-sign.mjs); `make` adds the DMG and ZIP.
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

import { APP_IDENTIFIER } from './app-identity.mjs';
import { CORE_WINDOWS_DLLS, coreBinaryName, coreBuildDir } from './core-binary.mjs';
import { fuseSettingsFor, parseBuildFlavor, toFuseConfig } from './fuses.mjs';
import {
  agentHostLayout,
  AGENT_HOST_DIR,
  copyAgentHostResources,
  resourcesDirOf,
} from './packaging/agent-host-layout.mjs';
import { embedAppIntents } from './packaging/app-intents.mjs';
import { MakerHdiutilDmg } from './packaging/maker-dmg.mjs';
import { copyVelopackRuntime } from './packaging/velopack-runtime.mjs';
import { resealElectron, signResourcesAndBundle } from './packaging/macos-sign.mjs';
import { stripLocalSymbols, trimElectronLocales } from './packaging/trim.mjs';

const flavor = parseBuildFlavor(process.env.PIARC_BUILD_FLAVOR);
const repoRoot = path.join(import.meta.dirname, '..', '..');

/**
 * Copies the Core module of this flavor into the app as `native/<name>`. The main process
 * loads it from app.asar.unpacked/native/ (src/main/core/native-path.ts). On Windows the DLLs
 * it imports (libghostty-vt) go next to it, where the loader looks first.
 */
async function copyCoreModule(buildPath: string, platform: string, arch: string): Promise<void> {
  const name = coreBinaryName(platform, arch);
  const source = path.join(coreBuildDir(repoRoot, flavor), name);
  if (!existsSync(source)) {
    throw new Error(
      `Core module ${source} is missing. Run \`npm run build:core -- --flavor ${flavor}\` ` +
        '(add --target <triple> for another architecture).',
    );
  }
  const destination = path.join(buildPath, 'native', name);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  // Trim only the packaged copy. The development package measures the same Core layout as
  // the release package, while the build:core output retains local symbols for debugging.
  if (platform === 'darwin') {
    await stripLocalSymbols(destination);
  }
  if (platform === 'win32') {
    for (const dll of CORE_WINDOWS_DLLS) {
      const dllSource = path.join(path.dirname(source), dll);
      if (!existsSync(dllSource)) {
        throw new Error(`${dllSource} is missing; build:core copies it next to the module.`);
      }
      await copyFile(dllSource, path.join(path.dirname(destination), dll));
    }
  }
}

/**
 * After packaging: puts the Agent Host resources next to app.asar and, on macOS, signs the
 * app in layers so the bundled Node keeps its official signature (ADR-0018 rule 2).
 */
async function finishPackage(outputPath: string, platform: string, arch: string): Promise<void> {
  const appName = 'PiArc';
  const resourcesDir = resourcesDirOf(outputPath, platform, appName);
  if (platform === 'darwin') {
    // Before the signatures are redone: Electron's locales other than the app's (I41).
    const removed = await trimElectronLocales(path.join(outputPath, `${appName}.app`));
    console.log(`removed ${String(removed.length)} Electron locales`);
    const app = path.join(outputPath, `${appName}.app`);
    await resealElectron(app);
    await embedAppIntents(repoRoot, app, arch);
  }
  const agentHost = await copyAgentHostResources({ repoRoot, resourcesDir, platform, arch });
  if (platform === 'darwin') {
    const nodeDir = path.join(agentHost, 'node');
    const signed = await signResourcesAndBundle(path.join(outputPath, `${appName}.app`), {
      keepSigned: [nodeDir],
    });
    console.log(
      `ad-hoc signed ${String(signed.length)} Mach-O files in Resources; ` +
        `${path.join(AGENT_HOST_DIR, agentHostLayout(platform).node)} keeps its own signature`,
    );
  }
}

const config: ForgeConfig = {
  outDir: path.join('out', flavor),
  packagerConfig: {
    // Required by OnlyLoadAppFromAsar and ASAR integrity validation. The DLLs the Windows
    // Core module imports stay out of the archive like the module itself (the plugin below
    // adds the .node pattern): the system loader cannot read from app.asar.
    asar: { unpack: '**/native/*.dll' },
    // design/brand/ is the single source of the icons (icon.icns, icon.ico); the packager
    // appends the platform's extension.
    icon: path.join(repoRoot, 'design', 'brand', 'icon'),
    appBundleId: APP_IDENTIFIER,
    // T35: the menu-bar and tray icons, exported from design/brand/mark.svg
    // (scripts/dev/export-tray-icons.mjs), next to the app's resources.
    extraResource: [
      'trayTemplate.png',
      'trayTemplate@2x.png',
      'tray-light.ico',
      'tray-dark.ico',
    ].map((name) => path.join(repoRoot, 'design', 'brand', name)),
    // macOS: `piarc://` links open PiArc (CFBundleURLTypes), and folders dropped on its Dock
    // icon reach it as `open-file` (CFBundleDocumentTypes). Windows registers both from the
    // Velopack hooks (src/main/platform/windows-shell.ts, ADR-0052).
    protocols: [{ name: 'PiArc', schemes: ['piarc'] }],
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Folder',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['public.folder'],
        },
      ],
    },
  },
  rebuildConfig: {},
  makers: [new MakerHdiutilDmg({}), new MakerZIP({}, ['darwin'])],
  hooks: {
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform, arch) => {
      await copyCoreModule(buildPath, platform, arch);
      if (platform === 'win32') {
        await copyVelopackRuntime({ repoRoot, buildPath, arch });
      }
    },
    postPackage: async (_config, { platform, arch, outputPaths }) => {
      for (const outputPath of outputPaths) {
        await finishPackage(outputPath, platform, arch);
      }
    },
  },
  plugins: [
    // Keeps every .node file out of app.asar (in app.asar.unpacked), so Core is loaded from
    // a real file and never reads from the archive (ADR-0014 rule 7).
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      // The name is also the output directory `.vite/renderer/main_window` (see
      // vite.renderer.config.ts) and the value of MAIN_WINDOW_VITE_NAME in the main process.
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin(toFuseConfig(fuseSettingsFor(flavor))),
  ],
};

export default config;
