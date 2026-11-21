// MCP commands of `window.piarc` (T36): the settings window's MCP page. Core stores the on/off
// choice per workspace and runs the pool's actions in the workspace's Agent Host; an MCP
// sign-in shows its steps on `core/login` like a provider's (answered with `answerLogin`).
import path from 'node:path';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type McpCore = Pick<
  CoreRuntime,
  'mcpStatus' | 'mcpReconnect' | 'mcpSetEnabled' | 'mcpLogin'
>;

function workspace(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError('workspace must be an absolute path');
  }
  return value;
}

/** Server names as Core accepts them (`piarc_config::mcp::valid_name`). */
function server(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new TypeError('name must be an MCP server name');
  }
  return value;
}

export function registerMcpHandlers(registerHandler: RegisterHandler, core: McpCore): void {
  registerHandler(IPC_CHANNELS.mcpStatus, (_event, [dir]) => core.mcpStatus(workspace(dir)));
  registerHandler(IPC_CHANNELS.mcpReconnect, (_event, [dir, name]) =>
    core.mcpReconnect(workspace(dir), server(name)),
  );
  registerHandler(IPC_CHANNELS.mcpSetEnabled, (_event, [dir, name, enabled]) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return core.mcpSetEnabled(workspace(dir), server(name), enabled);
  });
  registerHandler(IPC_CHANNELS.mcpLogin, (_event, [dir, name]) =>
    core.mcpLogin(workspace(dir), server(name)),
  );
}
