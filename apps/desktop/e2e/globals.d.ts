// `window.piarc` as the renderer sees it; tests still check its shape at runtime.
// `globalThis.__piarcEventProbe` is declared in src/shared/event-probe.ts.
import type {} from '../src/shared/event-probe.js';
import type { PiarcApi } from '../src/shared/ipc.js';

declare global {
  interface Window {
    readonly piarc: PiarcApi;
  }
}
