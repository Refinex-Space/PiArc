// Project trust in the Harness Kit (architecture sections 5.5 and 10.2): Core decides, Pi
// obeys. Pi's own decision path (extension `project_trust` handlers, `<agentDir>/trust.json`,
// the `defaultProjectTrust` setting) only runs in Pi's CLI; the SDK path asks the
// `resolveProjectTrust` hook of its resource loader. PiArc answers that hook with Core's
// `trust/get`, so project-level Pi resources (`.pi/extensions/`, `.pi/settings.json`,
// `.pi/mcp.json`, skills, prompts, SYSTEM.md) load only for projects Core trusts.
import type { CreateAgentSessionServicesOptions } from '@earendil-works/pi-coding-agent';

import { describeError } from '../protocol/errors.js';
import { parseTrust } from '../protocol/params.js';
import type { CoreBridge } from '../runtime/core-bridge.js';

type ReloadOptions = NonNullable<CreateAgentSessionServicesOptions['resourceLoaderReloadOptions']>;

/**
 * Asks Core whether `cwd` is a trusted project. Every failure — no answer in time, an error
 * response, a result that is not `{ trusted: boolean }`, a closed connection — is "not
 * trusted"; `log` gets the reason.
 */
export async function askCoreTrust(
  bridge: Pick<CoreBridge, 'requestTyped'>,
  cwd: string,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    const { trusted } = await bridge.requestTyped('trust/get', { path: cwd }, parseTrust);
    return trusted;
  } catch (error) {
    log(`trust/get for ${cwd} failed, treating it as untrusted: ${describeError(error)}`);
    return false;
  }
}

/** The decision of one session's resource loading, and the hook that makes it. */
export interface TrustTakeover {
  /** For `createAgentSessionServices({ resourceLoaderReloadOptions })`. */
  readonly reloadOptions: ReloadOptions;
  /** What the hook decided; `false` until it ran. */
  readonly trusted: () => boolean;
}

/**
 * Replaces Pi's project trust resolution for a resource loader in `cwd`. Pi first loads
 * global and inline extensions with project resources off, then calls the hook and reloads
 * with its answer; the hook never consults Pi's extensions or `trust.json`. Create the
 * session's `SettingsManager` with `projectTrusted: false`, so nothing project-level is read
 * before the hook answers.
 */
export function takeOverProjectTrust(
  cwd: string,
  isTrusted: (cwd: string) => Promise<boolean>,
): TrustTakeover {
  let decided = false;
  return {
    reloadOptions: {
      resolveProjectTrust: async () => {
        // A rejection here would fail the session; an unexpected one is still untrusted.
        decided = await isTrusted(cwd).catch(() => false);
        return decided;
      },
    },
    trusted: () => decided,
  };
}
