// Starts Core in the main process and shuts it down before the app exits (ADR-0014).
import type { App } from 'electron';

import { loadCoreModule } from './load.js';
import path from 'node:path';

import type { AgentHostOptions, CoreRuntime } from './native/piarc-core.js';
import { resolveCoreModulePath, type CoreModuleLocation } from './native-path.js';
import type { EventRouter } from './router.js';

/** The running Core. */
export interface CoreHost {
  readonly runtime: CoreRuntime;
  /** The `.node` file that was loaded. */
  readonly modulePath: string;
}

/**
 * Where workspaces start their Agent Host (T14): a packaged app's own runtime under
 * `resourcesPath` (bundled Node, ADR-0015); on the source tree the bundle
 * `npm run build:agent-host` writes, run on the `node` found on PATH.
 */
export function agentHostOptions(location: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
}): AgentHostOptions {
  if (location.isPackaged) {
    return { resourcesPath: location.resourcesPath };
  }
  const bundleDir = path.join(location.appPath, '..', '..', 'agent-host', 'dist', 'bundle');
  return {
    node: 'node',
    bundle: path.join(bundleDir, 'agent-host.mjs'),
    piPackageDir: path.join(bundleDir, 'pi-assets'),
  };
}

/**
 * Voice dictation's bundled assets (ADR-0094): `Resources/speech` in a packaged app; on the
 * source tree what `node scripts/dev/fetch-speech-assets.mjs` lays out for this platform.
 */
export function speechDir(location: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly resourcesPath: string;
}): string {
  if (location.isPackaged) return path.join(location.resourcesPath, 'speech');
  return path.join(
    location.appPath,
    '..',
    '..',
    'target',
    'speech-assets',
    `${process.platform}-${process.arch}`,
  );
}

/**
 * Loads Core and starts it on the data and cache directories (architecture section 9.1) with
 * every event batch going to `router`. Throws when the module cannot be loaded or Core does
 * not start.
 */
export function startCore(
  location: CoreModuleLocation & { readonly resourcesPath: string },
  router: EventRouter,
  dirs: { readonly dataDir: string; readonly cacheDir: string; readonly appVersion?: string },
  memoryKeychain = false,
): CoreHost {
  const modulePath = resolveCoreModulePath(location);
  const { CoreRuntime } = loadCoreModule(modulePath);
  const options = {
    ...dirs,
    agentHost: agentHostOptions(location),
    speechDir: speechDir(location),
  };
  const onEvents = (batches: Parameters<typeof router.forward>[0]) => {
    router.forward(batches);
  };
  // L4 runs every rebuilt package with a new ad-hoc signature, and macOS asks for the login
  // keychain password before such a build may read the vault's master key. A development
  // build of Core can keep the key in memory instead (`createForTests`); release builds do
  // not have it, so the switch does nothing there.
  const testing: unknown = CoreRuntime;
  const runtime =
    memoryKeychain &&
    typeof testing === 'function' &&
    'createForTests' in testing &&
    typeof testing.createForTests === 'function'
      ? (testing.createForTests as typeof CoreRuntime.create).call(CoreRuntime, options, onEvents)
      : CoreRuntime.create(options, onEvents);
  console.info(`[core] loaded ${modulePath}`);
  return { runtime, modulePath };
}

/** The environment switch L4 sets for development builds (see `startCore`). */
export const MEMORY_KEYCHAIN_ENV = 'PIARC_TEST_MEMORY_KEYCHAIN';

/**
 * Holds the app's exit until Core has shut down: the shutdown releases Core's event
 * callback, which would otherwise keep the main process's event loop alive, and lets Core
 * flush its last batch and stop its threads in order.
 */
export function shutdownCoreBeforeQuit(app: App, runtime: CoreRuntime): void {
  let stopping = false;
  app.on('will-quit', (event) => {
    if (runtime.state === 'stopped') {
      return;
    }
    event.preventDefault();
    if (stopping) {
      return;
    }
    stopping = true;
    console.info('[core] shutting down');
    runtime.shutdown().then(
      () => {
        console.info('[core] stopped');
        app.quit();
      },
      (error: unknown) => {
        console.error('[core] shutdown failed; quitting anyway', error);
        app.exit(1);
      },
    );
  });
}
