// `window.piarc` as the renderer sees it; tests still check its shape at runtime.
import type { PiarcApi } from '../src/shared/ipc.js';

declare global {
  interface Window {
    readonly piarc: PiarcApi;
  }
}
