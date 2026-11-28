// Installing a downloaded update on Windows (ADR-0111 rule 6): Velopack's UpdateManager reads
// the folder Core downloaded and verified (`releases.win-<arch>.json` and its Full package) as
// a local source, copies the package after checking its SHA-256 once more, and applies it
// after PiArc exits, restarting it. A copy Velopack did not install (L4's packaged form, a
// copied folder) has no Update.exe: the update is installed by hand.
import { createRequire } from 'node:module';
import path from 'node:path';

interface VelopackAsset {
  readonly Version: string;
}

interface UpdateInfo {
  readonly TargetFullRelease: VelopackAsset;
}

/** The part of Velopack's `UpdateManager` used here. */
export interface VelopackUpdates {
  getCurrentVersion(): string;
  checkForUpdatesAsync(): Promise<UpdateInfo | null>;
  downloadUpdateAsync(update: UpdateInfo): Promise<void>;
  waitExitThenApplyUpdate(update: UpdateInfo, silent?: boolean, restart?: boolean): void;
}

function isManagerClass(value: unknown): value is new (source: string) => VelopackUpdates {
  return typeof value === 'function';
}

/** Velopack's `UpdateManager` over the local `feed`, from the binding packed into app.asar. */
export function velopackManager(appPath: string, feed: string): VelopackUpdates {
  const load = createRequire(path.join(appPath, 'package.json'));
  const binding: unknown = load('velopack');
  const manager =
    typeof binding === 'object' && binding !== null && 'UpdateManager' in binding
      ? binding.UpdateManager
      : undefined;
  if (!isManagerClass(manager))
    throw new Error('the bundled Velopack binding has no UpdateManager');
  return new manager(feed);
}

/** Outcome of `applyWindowsUpdate`. */
export type WindowsInstall = 'applying' | 'notInstalled';

/**
 * Hands the update to Velopack, which applies it once PiArc exits. Throws when Velopack
 * finds another version than Core downloaded.
 */
export async function applyWindowsUpdate(
  manager: () => VelopackUpdates,
  version: string,
): Promise<WindowsInstall> {
  let updates: VelopackUpdates;
  try {
    updates = manager();
    updates.getCurrentVersion();
  } catch (error) {
    console.warn('[updates] not a Velopack installation', error);
    return 'notInstalled';
  }
  const info = await updates.checkForUpdatesAsync();
  if (info?.TargetFullRelease.Version !== version) {
    throw new Error(
      `Velopack found ${info?.TargetFullRelease.Version ?? 'no update'}, expected ${version}`,
    );
  }
  await updates.downloadUpdateAsync(info);
  updates.waitExitThenApplyUpdate(info, false, true);
  return 'applying';
}
