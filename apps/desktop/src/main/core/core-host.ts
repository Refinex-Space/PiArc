// Starts Core in the main process and shuts it down before the app exits (ADR-0014).
import type { App } from 'electron';

import { loadCoreModule } from './load.js';
import type { CoreRuntime } from './native/piarc-core.js';
import { resolveCoreModulePath, type CoreModuleLocation } from './native-path.js';
import type { EventRouter } from './router.js';

/** The running Core. */
export interface CoreHost {
  readonly runtime: CoreRuntime;
  /** The `.node` file that was loaded. */
  readonly modulePath: string;
}

/**
 * Loads Core and starts it on the data and cache directories (architecture section 9.1) with
 * every event batch going to `router`. Throws when the module cannot be loaded or Core does
 * not start.
 */
export function startCore(
  location: CoreModuleLocation,
  router: EventRouter,
  dirs: { readonly dataDir: string; readonly cacheDir: string },
): CoreHost {
  const modulePath = resolveCoreModulePath(location);
  const { CoreRuntime } = loadCoreModule(modulePath);
  const runtime = CoreRuntime.create({ ...dirs }, (batches) => {
    router.forward(batches);
  });
  console.info(`[core] loaded ${modulePath}`);
  return { runtime, modulePath };
}

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
