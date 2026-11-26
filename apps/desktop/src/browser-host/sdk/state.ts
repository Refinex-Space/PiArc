// Ported from ego-browser package/ego-browser/src/state.ts (ego-lite commit 56589ea8, MIT, see
// LICENSE). PiArc: no env file, workspace or file writer (the host has no Node); the platform comes
// from `navigator`; the response timeout and Page budget that upstream reads from
// EGO_BROWSER_RESPONSE_TIMEOUT_MS / EGO_BROWSER_PAGE_BUDGET are fields tests override.

import type { CdpObject } from './cdp-types.js';

/** Test hook: answers every `browserCdp` call instead of the bindings. */
export type CdpOverride = (
  method: string,
  params: CdpObject,
  sessionId: string | undefined,
  timeoutMs: number,
) => unknown;

export interface SdkState {
  cdpOverride: CdpOverride | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** `darwin`, `win32` or `linux`, as Node's `process.platform` names them. */
  platform: string;
  preferredTargetId: string | null;
  /** Overrides the CDP response timeout (upstream: EGO_BROWSER_RESPONSE_TIMEOUT_MS). */
  responseTimeoutMs: number | undefined;
  /** Overrides the managed-Page budget per Space (upstream: EGO_BROWSER_PAGE_BUDGET). */
  pageBudget: number | undefined;
}

function hostPlatform(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  if (/^mac/i.test(platform)) return 'darwin';
  if (/^win/i.test(platform)) return 'win32';
  return 'linux';
}

export const state: SdkState = {
  cdpOverride: null,
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  platform: hostPlatform(),
  preferredTargetId: null,
  responseTimeoutMs: undefined,
  pageBudget: undefined,
};

export function setOverrides(overrides: Partial<SdkState>): () => void {
  const previous = { ...state };
  Object.assign(state, overrides);
  return () => {
    Object.assign(state, previous);
  };
}
