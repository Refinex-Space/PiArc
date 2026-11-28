// In-app updates (ADR-0111): the About page's commands, the automatic check and installing.
// Core reads the signed manifest, downloads and verifies the files through the user's proxy;
// the main process only forwards, schedules and installs what Core's install plan names.
// The page sends no arguments: it cannot choose a file, URL or version.
import { IPC_CHANNELS, type AboutInfo, type UpdateInstallOutcome } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type UpdatesCore = Pick<
  CoreRuntime,
  | 'updateStatus'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'cancelUpdateDownload'
  | 'updateInstallPlan'
>;

/** What Core's install plan names (`UpdateInstall`). */
export type InstallPlan =
  | { readonly platform: 'macos'; readonly version: string; readonly archive: string }
  | { readonly platform: 'windows'; readonly version: string; readonly feed: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses Core's `UpdateInstall` JSON. */
export function parseInstallPlan(text: string): InstallPlan {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value.version !== 'string') {
    throw new TypeError('invalid install plan');
  }
  if (value.platform === 'macos' && typeof value.archive === 'string') {
    return { platform: 'macos', version: value.version, archive: value.archive };
  }
  if (value.platform === 'windows' && typeof value.feed === 'string') {
    return { platform: 'windows', version: value.version, feed: value.feed };
  }
  throw new TypeError('invalid install plan');
}

/** How the platform installs a plan once the user agreed to quit. */
export interface Installer {
  /** Whether PiArc may quit now (asks when sessions or background tasks run). */
  readonly confirmQuit: () => Promise<boolean>;
  /**
   * Prepares the update and hands it to the platform; answers `restarting` (PiArc must quit
   * next) or why the update has to be installed by hand.
   */
  readonly install: (plan: InstallPlan) => Promise<UpdateInstallOutcome>;
  readonly quit: () => void;
}

/** The ready update, installed: plan, confirmation, platform step, quit. */
export async function installUpdate(
  core: Pick<UpdatesCore, 'updateInstallPlan'>,
  installer: Installer,
): Promise<UpdateInstallOutcome> {
  const plan = parseInstallPlan(await core.updateInstallPlan());
  if (!(await installer.confirmQuit())) return { kind: 'cancelled' };
  const outcome = await installer.install(plan);
  if (outcome.kind === 'restarting') installer.quit();
  return outcome;
}

/** The automatic check: 30 s after start, then whenever 24 hours passed since the last one. */
export const FIRST_CHECK_MS = 30_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

export interface SchedulerPorts {
  readonly check: () => Promise<unknown>;
  /** The user's `updates.autoCheck`. */
  readonly enabled: () => boolean;
  readonly now: () => number;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
}

/** Runs the automatic check (ADR-0111 rule 3); manual checks go straight to Core. */
export class UpdateScheduler {
  private timer: unknown;
  private last: number | undefined;

  constructor(private readonly ports: SchedulerPorts) {}

  start(): void {
    this.schedule(FIRST_CHECK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) this.ports.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.stop();
    this.timer = this.ports.setTimer(() => {
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    const now = this.ports.now();
    if (this.ports.enabled() && (this.last === undefined || now - this.last >= CHECK_INTERVAL_MS)) {
      this.last = now;
      try {
        await this.ports.check();
      } catch (error) {
        console.warn('[updates] the automatic check failed', error);
      }
    }
    this.schedule(TICK_MS);
  }
}

export function registerUpdateHandlers(
  registerHandler: RegisterHandler,
  core: UpdatesCore,
  installer: Installer,
  about: () => AboutInfo,
): void {
  registerHandler(IPC_CHANNELS.updateStatus, () => core.updateStatus());
  registerHandler(IPC_CHANNELS.updateCheck, () => core.checkForUpdates());
  registerHandler(IPC_CHANNELS.updateDownload, () => core.downloadUpdate());
  registerHandler(IPC_CHANNELS.updateCancel, () => core.cancelUpdateDownload());
  registerHandler(IPC_CHANNELS.updateInstall, () => installUpdate(core, installer));
  registerHandler(IPC_CHANNELS.aboutInfo, () => about());
}
