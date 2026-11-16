// The data and cache directories (architecture section 9.1), fixed before `ready`.
//
// macOS: `~/Library/Application Support/PiArc/` and `~/Library/Caches/PiArc/`.
// Windows: `%LOCALAPPDATA%\PiArc\` and `%LOCALAPPDATA%\PiArc\Cache\`, not Electron's default
// `%APPDATA%` (roaming profiles would carry session data and snapshots around).
// `--user-data-dir=<dir>` (tests, separate profiles) puts both under `<dir>`.
import path from 'node:path';

/** The directory name under the platform's application data location. */
export const APP_DIR_NAME = 'PiArc';

export interface DataDirInputs {
  readonly platform: NodeJS.Platform;
  /** The user's home directory. */
  readonly home: string;
  /** `%LOCALAPPDATA%` (Windows). */
  readonly localAppData: string | undefined;
  /** The value of `--user-data-dir`, when given. */
  readonly userDataOverride: string | undefined;
}

export interface DataDirs {
  /** Electron's `userData` and Core's data directory. */
  readonly data: string;
  /** Core's cache directory (discardable). */
  readonly cache: string;
  /** Electron's `sessionData`: Chromium's caches and storage, inside the cache directory. */
  readonly sessionData: string;
}

/** Computes the directories; pure, so both platforms are tested on either. */
export function resolveDataDirs(inputs: DataDirInputs): DataDirs {
  const paths = inputs.platform === 'win32' ? path.win32 : path.posix;
  let data: string;
  let cache: string;
  if (inputs.userDataOverride !== undefined && inputs.userDataOverride !== '') {
    data = paths.resolve(inputs.userDataOverride);
    cache = paths.join(data, 'Cache');
  } else if (inputs.platform === 'darwin') {
    data = paths.join(inputs.home, 'Library', 'Application Support', APP_DIR_NAME);
    cache = paths.join(inputs.home, 'Library', 'Caches', APP_DIR_NAME);
  } else if (inputs.platform === 'win32') {
    const local =
      inputs.localAppData !== undefined && inputs.localAppData !== ''
        ? inputs.localAppData
        : paths.join(inputs.home, 'AppData', 'Local');
    data = paths.join(local, APP_DIR_NAME);
    cache = paths.join(data, 'Cache');
  } else {
    // Not a shipping platform; the XDG locations keep development builds runnable.
    data = paths.join(inputs.home, '.local', 'share', APP_DIR_NAME);
    cache = paths.join(inputs.home, '.cache', APP_DIR_NAME);
  }
  return { data, cache, sessionData: paths.join(cache, 'Chromium') };
}

/** The parts of Electron's `app` the directories are applied with. */
export interface PathApp {
  isReady(): boolean;
  getPath(name: 'home'): string;
  setPath(name: 'userData' | 'sessionData', value: string): void;
  readonly commandLine: { getSwitchValue(name: string): string };
}

/**
 * Resolves the directories for this process and applies them to Electron. Must run before
 * `ready` (and before the single-instance lock, which lives in `userData`): Electron reads
 * `userData` and `sessionData` when it starts the default session.
 */
export function applyDataDirs(
  app: PathApp,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): DataDirs {
  if (app.isReady()) {
    throw new Error('the data directories must be set before the app is ready');
  }
  const dirs = resolveDataDirs({
    platform,
    home: app.getPath('home'),
    localAppData: env.LOCALAPPDATA,
    userDataOverride: app.commandLine.getSwitchValue('user-data-dir'),
  });
  app.setPath('userData', dirs.data);
  app.setPath('sessionData', dirs.sessionData);
  return dirs;
}
