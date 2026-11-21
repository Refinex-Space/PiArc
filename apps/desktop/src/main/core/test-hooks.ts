// Hooks for L4 tests and the S2 benchmark (scripts/bench/), reachable from Playwright's
// `electronApp.evaluate` as `globalThis.__piarcTestHooks`. They are installed only when the
// loaded Core is a development build (it has the testing exports); release builds load a
// Core without them, so the hooks never exist there.
import { monitorEventLoopDelay, performance, type ELDHistogram } from 'node:perf_hooks';

import { Notification, webContents } from 'electron';

import type { LaunchTarget } from '../../shared/ipc.js';
import type {
  AttentionObservation,
  ForwardObservation,
  NotificationProbeEvent,
  TerminalForwardStats,
  TrayObservation,
} from '../../shared/test-hooks.js';
import type { TestingCore } from './load.js';
import type { EventRouter } from './router.js';
import type { TerminalOwners } from './terminal-ipc.js';

/**
 * Sampling interval of the event-loop delay monitor. The histogram records the whole
 * interval between two samples, so every value includes this much on top of the delay.
 */
export const LOOP_DELAY_RESOLUTION_MS = 1;

export function installTestHooks(options: {
  readonly modulePath: string;
  readonly core: TestingCore;
  readonly router: EventRouter;
  readonly openWindow: (hash: string) => Promise<number>;
  readonly terminalOwners: TerminalOwners;
  readonly terminalStats: TerminalForwardStats;
  readonly attention: () => AttentionObservation;
  readonly failNext: (channel: string, message: string) => void;
  readonly holdNext: (channel: string, ms: number) => void;
  readonly answerConfirm: (answer: boolean) => void;
  readonly confirmations: () => readonly { readonly message: string; readonly detail: string }[];
  readonly tray: () => TrayObservation | undefined;
  readonly launch: (target: LaunchTarget) => void;
  readonly quit: () => void;
  readonly mainWindows: () => number[];
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
    tray: options.tray,
    launch: options.launch,
    quit: options.quit,
    mainWindows: options.mainWindows,
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
      histogram = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
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
        resolutionMs: LOOP_DELAY_RESOLUTION_MS,
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
    createTerminal: async (webContentsId, terminal) => {
      const owner = webContents.fromId(webContentsId);
      if (owner === undefined) {
        throw new Error(`No window has webContents id ${String(webContentsId)}`);
      }
      const page = options.terminalOwners.page(owner);
      const id = await options.core.createTerminal({ ...terminal });
      if (!options.terminalOwners.assign(id, owner, page)) {
        throw new Error('The window navigated while its terminal started');
      }
      return id;
    },
    terminalForwardStats: () => ({ ...options.terminalStats }),
    attention: options.attention,
    failNext: options.failNext,
    holdNext: options.holdNext,
    answerConfirm: options.answerConfirm,
    confirmations: options.confirmations,
    showNotification: (title, body, waitMs) =>
      new Promise((resolve) => {
        const supported = Notification.isSupported();
        const events: NotificationProbeEvent[] = [];
        const started = performance.now();
        const at = (): number => Math.round(performance.now() - started);
        if (!supported) {
          resolve({ supported, events });
          return;
        }
        const notification = new Notification({ title, body, silent: true });
        notification.on('show', () => events.push({ type: 'show', atMs: at() }));
        notification.on('failed', (_event, error) => {
          events.push({ type: 'failed', atMs: at(), detail: error });
        });
        notification.on('click', () => events.push({ type: 'click', atMs: at() }));
        notification.on('close', () => events.push({ type: 'close', atMs: at() }));
        notification.show();
        setTimeout(() => {
          resolve({ supported, events: [...events] });
        }, waitMs);
      }),
  };
  console.info('[core] test hooks installed (development build of Core)');
}
