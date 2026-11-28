// `window.piarc` as the renderer sees it; tests still check its shape at runtime.
// `globalThis.__piarcEventProbe` and `__piarcTranscriptLab` are declared in src/shared.
import type {} from '../src/shared/event-probe.js';
import type {} from '../src/shared/transcript-lab.js';
import type { PiarcApi } from '../src/shared/ipc.js';

declare global {
  interface Window {
    readonly piarc: PiarcApi;
  }
}
