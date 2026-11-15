// Loads one Core module and runs its event channel once. Used by scripts/ci/load-core.mjs in
// two hosts: plain Node (`node core-load-check.mjs <module>`) and Electron, where it is the
// main script of a throwaway app (`electron <app dir> <module>`). It prints one JSON line
// prefixed with RESULT_PREFIX and exits 0 when every check passed.
//
// A development build is checked fully (2,000 demo events complete and in order, a panic
// turned into an internalError, ordered shutdown); a release build, which has no testing
// exports, only through create and shutdown.
import path from 'node:path';

export const RESULT_PREFIX = 'core-load-check ';

const EVENTS = 2_000;

/**
 * @typedef {{ route: string, seq: number, payload: Uint8Array }} Batch
 * @typedef {{
 *   readonly state: string,
 *   shutdown(): Promise<void>,
 *   startDemoSource?: (options: { route: string, eventsPerSecond: number, maxEvents: number }) => number,
 *   triggerPanic?: () => void,
 * }} Runtime
 * @typedef {{
 *   host: string, platform: string, arch: string, module: string, testingExports: boolean,
 *   events: number, ordered: boolean, panicKind: string | null, finalState: string, ok: boolean,
 * }} CheckResult
 */

/**
 * @param {unknown} value
 * @returns {value is { CoreRuntime: { create(options: object, onEvents: (batches: Batch[]) => void): Runtime } }}
 */
function isCoreModule(value) {
  if (typeof value !== 'object' || value === null || !('CoreRuntime' in value)) {
    return false;
  }
  const runtime = value.CoreRuntime;
  return (
    typeof runtime === 'function' && 'create' in runtime && typeof runtime.create === 'function'
  );
}

/** @param {unknown} error */
function kindOf(error) {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const data = error.data;
    if (
      typeof data === 'object' &&
      data !== null &&
      'kind' in data &&
      typeof data.kind === 'string'
    ) {
      return data.kind;
    }
  }
  return null;
}

/**
 * @param {string} modulePath
 * @param {string} host
 * @returns {Promise<CheckResult>}
 */
export async function checkCore(modulePath, host) {
  const module = { exports: /** @type {unknown} */ ({}) };
  process.dlopen(module, modulePath);
  if (!isCoreModule(module.exports)) {
    throw new Error(`${modulePath} does not export CoreRuntime`);
  }
  /** @type {number[]} */
  const seqs = [];
  const decoder = new TextDecoder();
  const core = module.exports.CoreRuntime.create({}, (batches) => {
    for (const batch of batches) {
      /** @type {unknown} */
      const events = JSON.parse(decoder.decode(batch.payload));
      if (Array.isArray(events)) {
        for (const event of /** @type {unknown[]} */ (events)) {
          if (
            typeof event === 'object' &&
            event !== null &&
            'seq' in event &&
            typeof event.seq === 'number'
          ) {
            seqs.push(event.seq);
          }
        }
      }
    }
  });
  const testingExports =
    typeof core.startDemoSource === 'function' && typeof core.triggerPanic === 'function';
  /** @type {string | null} */
  let panicKind = null;
  if (testingExports && core.startDemoSource !== undefined && core.triggerPanic !== undefined) {
    core.startDemoSource({ route: 'load-check', eventsPerSecond: 10_000, maxEvents: EVENTS });
    const deadline = Date.now() + 15_000;
    while (seqs.length < EVENTS && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try {
      core.triggerPanic();
    } catch (error) {
      panicKind = kindOf(error);
    }
  }
  await core.shutdown();
  const ordered = seqs.every((seq, index) => seq === index + 1);
  const finalState = core.state;
  const ok = testingExports
    ? seqs.length === EVENTS && ordered && panicKind === 'internalError' && finalState === 'stopped'
    : finalState === 'stopped';
  return {
    host,
    platform: process.platform,
    arch: process.arch,
    module: path.basename(modulePath),
    testingExports,
    events: seqs.length,
    ordered,
    panicKind,
    finalState,
    ok,
  };
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

const modulePath = process.argv.at(-1) ?? '';
const isEntry = modulePath.endsWith('.node');

if (isEntry && 'electron' in process.versions) {
  // Electron main process of the throwaway app. `ready` fires only after this entry module
  // has finished evaluating, so it must not be awaited at the top level.
  const { app } = await import('electron');
  void app.whenReady().then(async () => {
    try {
      const result = await checkCore(modulePath, `electron ${process.versions.electron}`);
      console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
      app.exit(result.ok ? 0 : 1);
    } catch (error) {
      console.error(`core-load-check failed: ${message(error)}`);
      app.exit(1);
    }
  });
} else if (isEntry && process.argv[1]?.endsWith('core-load-check.mjs') === true) {
  try {
    const result = await checkCore(modulePath, `node ${process.versions.node}`);
    console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`core-load-check failed: ${message(error)}`);
    process.exitCode = 1;
  }
}
