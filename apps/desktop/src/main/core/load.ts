// Loads the Core native module from the path native-path.ts resolved.
import type { CoreRuntime } from './native/piarc-core.js';
import type { CoreRuntime as TestingCoreRuntime } from './native/piarc-core.testing.js';

/** The exports of the Core module (generated declarations in ./native/). */
export interface CoreModule {
  readonly CoreRuntime: typeof CoreRuntime;
}

/** A Core runtime from a development build, which also has the testing exports. */
export type TestingCore = TestingCoreRuntime;

/**
 * Loads the module at `modulePath` (an absolute path outside any asar) and checks that it is
 * PiArc Core. Throws when the file is missing, built for another platform or not Core.
 */
export function loadCoreModule(modulePath: string): CoreModule {
  const module: { exports: unknown } = { exports: {} };
  process.dlopen(module, modulePath);
  if (!isCoreModule(module.exports)) {
    throw new Error(`${modulePath} does not export PiArc Core's CoreRuntime`);
  }
  return module.exports;
}

function isCoreModule(value: unknown): value is CoreModule {
  if (typeof value !== 'object' || value === null || !('CoreRuntime' in value)) {
    return false;
  }
  const runtime: unknown = value.CoreRuntime;
  return (
    typeof runtime === 'function' && 'create' in runtime && typeof runtime.create === 'function'
  );
}

/** True for a runtime from a development build (demo sources, echo, panic triggers). */
export function hasTestingExports(core: CoreRuntime): core is TestingCore {
  const candidate: object = core;
  return (
    'startDemoSource' in candidate &&
    typeof candidate.startDemoSource === 'function' &&
    'triggerPanic' in candidate &&
    typeof candidate.triggerPanic === 'function'
  );
}
