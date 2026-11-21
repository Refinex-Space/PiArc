// An MCP server's sign-in as Core runs it (`mcp/login`, T36): the authorization page and the
// paste prompt go to the client through `ui/loginInteraction` with Core's login id, like a
// provider's sign-in (T29); the tokens go to the vault through the server's store.
import type { LoginInteraction, McpServerStatus } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import type { McpPool } from './pool.js';

export async function signInToServer(
  pool: McpPool,
  bridge: CoreBridge,
  name: string,
  loginId: string,
): Promise<McpServerStatus> {
  const provider = `mcp:${name}`;
  const controller = new AbortController();
  const send = (interaction: LoginInteraction, signal: AbortSignal): Promise<unknown> =>
    // The user takes as long as they take; Core's sign-in limit or a cancel ends it.
    bridge.request(
      'ui/loginInteraction',
      { loginId, provider, interaction },
      { signal, timeoutMs: null },
    );
  try {
    return await pool.signIn(
      name,
      (url) => {
        send({ type: 'authUrl', url }, controller.signal).catch(() => undefined);
      },
      async (signal) => {
        try {
          const answer = await send(
            {
              type: 'prompt',
              kind: 'manualCode',
              message:
                'If the browser cannot reach PiArc after you approve, paste the address it opened.',
              placeholder: 'http://127.0.0.1:…/callback?code=…',
            },
            AbortSignal.any([signal, controller.signal]),
          );
          return isObject(answer) && typeof answer.value === 'string' ? answer.value : undefined;
        } catch {
          // Cancelled by the user, or the callback arrived first: nothing pasted.
          return undefined;
        }
      },
      controller.signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) throw new AhpError('cancelled', 'The sign-in was cancelled');
    throw error instanceof AhpError ? error : new AhpError('permissionDenied', message);
  } finally {
    controller.abort();
  }
}
