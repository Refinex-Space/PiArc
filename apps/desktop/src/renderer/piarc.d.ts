// `window.piarc` is exposed by the preload script (src/preload/preload.ts).
import type { PiarcApi } from '../shared/ipc.js';

declare global {
  interface Window {
    readonly piarc: PiarcApi;
  }
}
