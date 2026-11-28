// Velopack's startup hook (Windows installers, ADR-0018 rule 3). The installer and updater
// start PiArc.exe with hook arguments (install, update, uninstall) and expect the app to
// handle them and exit; `VelopackApp.build().run()` does that and returns at once on a normal
// start. It must run before anything else in the main process.
//
// The binding is not bundled: packaging copies it into app.asar's node_modules for Windows
// builds only (packaging/velopack-runtime.mjs), and it is loaded from there at run time.
//
// T35: the install and update hooks register the `piarc://` scheme and Explorer's "Open with
// PiArc" for the installed executable; the uninstall hook removes them (windows-shell.ts).
import { createRequire } from 'node:module';
import path from 'node:path';

import { app } from 'electron';

import { runRegistry, shellRegistration, shellUnregistration } from './windows-shell.js';

interface VelopackBuilder {
  onAfterInstallFastCallback(callback: () => void): VelopackBuilder;
  onAfterUpdateFastCallback(callback: () => void): VelopackBuilder;
  onBeforeUninstallFastCallback(callback: () => void): VelopackBuilder;
  run(): void;
}

interface VelopackBinding {
  readonly VelopackApp: { build(): VelopackBuilder };
}

function isVelopackBinding(value: unknown): value is VelopackBinding {
  if (typeof value !== 'object' || value === null || !('VelopackApp' in value)) {
    return false;
  }
  const { VelopackApp } = value;
  return (
    (typeof VelopackApp === 'object' || typeof VelopackApp === 'function') &&
    VelopackApp !== null &&
    'build' in VelopackApp &&
    typeof VelopackApp.build === 'function'
  );
}

/**
 * Runs Velopack's hooks in packaged Windows builds. A build that was not installed by
 * Velopack (the L4 packaged form, a copied folder) has no Update.exe next to it; the binding
 * then reports an error, which is logged and the app starts normally.
 */
export function runVelopackStartup(): void {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return;
  }
  try {
    const load = createRequire(path.join(app.getAppPath(), 'package.json'));
    const binding: unknown = load('velopack');
    if (!isVelopackBinding(binding)) {
      console.error('[velopack] the bundled binding has no VelopackApp');
      return;
    }
    const register = () => {
      runRegistry(shellRegistration(process.execPath));
    };
    binding.VelopackApp.build()
      .onAfterInstallFastCallback(register)
      .onAfterUpdateFastCallback(register)
      .onBeforeUninstallFastCallback(() => {
        runRegistry(shellUnregistration());
      })
      .run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[velopack] startup hooks not run: ${reason}`);
  }
}
