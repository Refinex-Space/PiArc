// `window.piarc` is exposed by the preload script (src/preload/preload.ts).
import type { PiarcApi } from '../shared/ipc.js';

declare global {
  interface Window {
    readonly piarc: PiarcApi;
  }
  /** Replaced at build time (vite.renderer.config.ts): true in the release flavor only. */
  const __PIARC_RELEASE_BUILD__: boolean;
}
