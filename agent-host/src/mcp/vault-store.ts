// An MCP server's OAuth state (client registration, tokens, the pending PKCE verifier) in Core's
// vault under `mcp/<server>` (architecture section 9.1, T36): never in a file. pi-mcp's sign-in
// and auth provider read and write it through this store; Core's key lock keeps two Agent Hosts
// (two workspaces using the same user server) from refreshing the same rotating refresh token.
import { McpRefreshLockBusyError, type McpOAuthServerStore } from '@earendil-works/pi-mcp/oauth';
import type { McpOAuthState } from '@earendil-works/pi-mcp/oauth';

import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import { AhpError } from '../protocol/errors.js';

/** How long a refresh may wait for another Agent Host's refresh of the same server. */
const LOCK_WAIT_MS = 25_000;

/** The vault key of a server's OAuth state. */
export function vaultKey(server: string): string {
  return `mcp/${server}`;
}

function optionalRecord(value: unknown): boolean {
  return value === undefined || isObject(value);
}

/** Whether a vault value has the shape of pi-mcp's OAuth state. */
export function isOAuthState(value: unknown): value is McpOAuthState {
  return (
    isObject(value) &&
    typeof value.serverUrl === 'string' &&
    optionalRecord(value.clientInformation) &&
    optionalRecord(value.tokens) &&
    optionalRecord(value.discovery) &&
    (value.tokensExpireAt === undefined || typeof value.tokensExpireAt === 'number') &&
    (value.codeVerifier === undefined || typeof value.codeVerifier === 'string') &&
    (value.oauthState === undefined || typeof value.oauthState === 'string') &&
    (!isObject(value.tokens) || typeof value.tokens.access_token === 'string')
  );
}

/** The OAuth state store of `server`, backed by the vault. */
export function vaultStore(
  bridge: CoreBridge,
  server: string,
  log: (line: string) => void,
): McpOAuthServerStore {
  const key = vaultKey(server);
  // Writes inside the refresh lock must carry its id, or Core would make them wait for it.
  let lockId: string | undefined;
  return {
    async load() {
      const result = await bridge.request('secrets/get', { key });
      const entry = isObject(result) ? result.entry : undefined;
      const value = isObject(entry) ? entry.value : undefined;
      return isOAuthState(value) ? value : undefined;
    },
    async save(state) {
      await bridge.request('secrets/set', {
        key,
        value: state,
        ...(lockId === undefined ? {} : { lockId }),
      });
    },
    async withRefreshLock(fn) {
      let grant: unknown;
      try {
        grant = await bridge.request(
          'secrets/lock',
          { keys: [key], deadlineMs: Date.now() + LOCK_WAIT_MS },
          { timeoutMs: LOCK_WAIT_MS + 1_000 },
        );
      } catch (error) {
        if (error instanceof AhpError && (error.kind === 'timeout' || error.kind === 'busy')) {
          throw new McpRefreshLockBusyError();
        }
        throw error;
      }
      if (!isObject(grant) || typeof grant.lockId !== 'string') {
        throw new AhpError('invalidRequest', 'secrets/lock returned a malformed result');
      }
      const held = grant.lockId;
      const lease = typeof grant.expiresInMs === 'number' ? grant.expiresInMs : 30_000;
      // A refresh can outlast the lease on a slow authorization server: keep it alive.
      const timer = setInterval(
        () => {
          bridge.request('secrets/renew', { lockId: held }).catch(() => undefined);
        },
        Math.max(1_000, Math.floor(lease / 3)),
      );
      timer.unref();
      lockId = held;
      try {
        return await fn();
      } finally {
        lockId = undefined;
        clearInterval(timer);
        await bridge.request('secrets/unlock', { lockId: held }).catch((error: unknown) => {
          log(`releasing the lock of ${key} failed: ${String(error)}`);
        });
      }
    },
  };
}

/** Removes a server's stored OAuth state (sign out). */
export async function forgetOAuth(bridge: CoreBridge, server: string): Promise<void> {
  await bridge.request('secrets/delete', { key: vaultKey(server) });
}
