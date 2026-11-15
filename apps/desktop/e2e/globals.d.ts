// `window.piarc` as the renderer sees it; tests still check its shape at runtime.
import type { EventProbeApi } from '../src/shared/event-probe.js';
import type { PiarcApi } from '../src/shared/ipc.js';

declare global {
  interface Window {
    readonly piarc: PiarcApi;
    /** Present on the event probe page (`#/event-probe`) only. */
    readonly __piarcEventProbe?: EventProbeApi;
  }
}
