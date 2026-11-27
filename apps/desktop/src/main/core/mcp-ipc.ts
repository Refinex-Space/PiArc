// MCP commands of `window.piarc` (T36): the settings window's MCP page. Core stores the on/off
// choice per workspace and runs the pool's actions in the workspace's Agent Host; an MCP
// sign-in shows its steps on `core/login` like a provider's (answered with `answerLogin`).
// Adding a server (ADR-0101) writes configuration that runs a program or reaches an address:
// the main process shows it in a native confirmation first, and the page cannot skip that.
import path from 'node:path';

import { BrowserWindow } from 'electron';

import { IPC_CHANNELS, type McpServerInput } from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';
import type { NativeConfirm, ShownConfirmation } from './plugins-ipc.js';

/** The part of Core these commands use. */
export type McpCore = Pick<
  CoreRuntime,
  'mcpStatus' | 'mcpReconnect' | 'mcpSetEnabled' | 'mcpLogin' | 'mcpAddServer'
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
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(value) || value.includes('__')) {
    throw new TypeError('name must be an MCP server name');
  }
  return value;
}

const MAX_TEXT = 4096;
const MAX_ITEMS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function line(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_TEXT ||
    value.includes('\0')
  ) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

/** A server from the page, checked; Core checks the definition again. */
export function serverInput(raw: unknown): McpServerInput {
  if (!isRecord(raw)) throw new TypeError('server must be an object');
  const scope = raw.scope;
  if (scope !== 'user' && scope !== 'projectLocal') {
    throw new TypeError('scope must be user or projectLocal');
  }
  const name = server(raw.name);
  if (raw.transport === 'http') {
    const url = line(raw.url, 'url');
    if (!/^https?:\/\/\S+$/u.test(url)) throw new TypeError('url must be an http(s) address');
    return { scope, name, transport: 'http', url };
  }
  if (raw.transport !== 'stdio') throw new TypeError('transport must be stdio or http');
  const args = raw.args;
  if (
    !Array.isArray(args) ||
    args.length > MAX_ITEMS ||
    !args.every((a) => typeof a === 'string' && a.length <= MAX_TEXT && !a.includes('\0'))
  ) {
    throw new TypeError('args must be a list of strings');
  }
  const env = raw.env;
  if (!isRecord(env) || Object.keys(env).length > MAX_ITEMS) {
    throw new TypeError('env must map names to strings');
  }
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key) ||
      typeof value !== 'string' ||
      value.length > MAX_TEXT ||
      value.includes('\0')
    ) {
      throw new TypeError('env must map names to strings');
    }
    vars[key] = value;
  }
  return {
    scope,
    name,
    transport: 'stdio',
    command: line(raw.command, 'command'),
    args: args.filter((a): a is string => typeof a === 'string'),
    env: vars,
  };
}

/** The `mcpServers` entry Core writes. */
export function definitionOf(input: McpServerInput): Record<string, unknown> {
  if (input.transport === 'http') return { type: 'http', url: input.url };
  return {
    type: 'stdio',
    command: input.command,
    ...(input.args.length === 0 ? {} : { args: input.args }),
    ...(Object.keys(input.env).length === 0 ? {} : { env: input.env }),
  };
}

/** What the confirmation shows: where it is written, what runs or is reached, and which
 * variables are set (names only: values may be tokens). */
export function addConfirmation(t: Translator, input: McpServerInput): ShownConfirmation {
  const lines = [
    t.t(input.scope === 'user' ? 'mcp.add.scope.user' : 'mcp.add.scope.projectLocal'),
    input.transport === 'http'
      ? t.t('mcp.add.confirmUrl', { url: input.url })
      : t.t('mcp.add.confirmCommand', {
          command: [input.command, ...input.args.map((a) => JSON.stringify(a))].join(' '),
        }),
  ];
  if (input.transport === 'stdio' && Object.keys(input.env).length > 0) {
    lines.push(t.t('mcp.add.confirmEnv', { names: Object.keys(input.env).join(', ') }));
  }
  return { message: t.t('mcp.add.confirm', { name: input.name }), detail: lines.join('\n') };
}

const CANCELLED = JSON.stringify({ status: 'cancelled' });

export function registerMcpHandlers(
  registerHandler: RegisterHandler,
  core: McpCore,
  translator: () => Translator,
  confirm: NativeConfirm,
): void {
  registerHandler(IPC_CHANNELS.mcpAddServer, async (event, [dir, raw]) => {
    const root = workspace(dir);
    const input = serverInput(raw);
    const t = translator();
    const window = BrowserWindow.fromWebContents(event.sender);
    const text = addConfirmation(t, input);
    if (!(await confirm.ask(window, text, [t.t('mcp.add.submit'), t.t('dialog.cancel')]))) {
      return CANCELLED;
    }
    return core.mcpAddServer(root, input.scope, input.name, JSON.stringify(definitionOf(input)));
  });
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
