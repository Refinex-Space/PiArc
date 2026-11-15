// Hooks for L4 tests and the S2 benchmark (scripts/bench/), reachable from Playwright's
// `electronApp.evaluate` as `globalThis.__piarcTestHooks`. They are installed only when the
// loaded Core is a development build (it has the testing exports); release builds load a
// Core without them, so the hooks never exist there.
import { monitorEventLoopDelay, performance, type ELDHistogram } from 'node:perf_hooks';

import type { ForwardObservation } from '../../shared/test-hooks.js';
import type { TestingCore } from './load.js';
import type { EventRouter } from './router.js';

export function installTestHooks(options: {
  readonly modulePath: string;
  readonly core: TestingCore;
  readonly router: EventRouter;
  readonly openWindow: (hash: string) => Promise<number>;
}): void {
  const { router } = options;
  let histogram: ELDHistogram | undefined;
  let timings: ForwardObservation[] = [];
  globalThis.__piarcTestHooks = {
    modulePath: options.modulePath,
    core: options.core,
    routerStats: () => router.stats(),
    routesOf: (id) => router.routesOf(id),
    openWindow: options.openWindow,
    measureEcho: (route, payload, calls) => {
      const durations: number[] = [];
      for (let i = 0; i < calls; i += 1) {
        const started = performance.now();
        options.core.echo(route, payload);
        durations.push(performance.now() - started);
      }
      return durations;
    },
    startLoopDelay: () => {
      histogram?.disable();
      histogram = monitorEventLoopDelay({ resolution: 10 });
      histogram.enable();
    },
    stopLoopDelay: () => {
      if (histogram === undefined) {
        throw new Error('startLoopDelay was not called');
      }
      histogram.disable();
      const ns = histogram;
      histogram = undefined;
      return {
        p50: ns.percentile(50) / 1e6,
        p99: ns.percentile(99) / 1e6,
        max: ns.max / 1e6,
        mean: ns.mean / 1e6,
        samples: ns.count,
      };
    },
    startForwardTimings: () => {
      timings = [];
      router.observe((observation) => timings.push(observation));
    },
    stopForwardTimings: () => {
      router.observe(undefined);
      const recorded = timings;
      timings = [];
      return recorded;
    },
  };
  console.info('[core] test hooks installed (development build of Core)');
}
