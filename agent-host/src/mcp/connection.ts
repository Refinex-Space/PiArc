// One configured MCP server's connection in the workspace pool (T36): the MCP client, its
// transport (PiArc's stdio transport or pi-mcp's Streamable HTTP), the cached tool list and
// server instructions, and OAuth through pi-mcp with the state in Core's vault. The pool decides
// when to connect and disconnect; this class connects on demand and reports what changed.
import path from 'node:path';

import {
  McpAuthRequiredError,
  McpClient,
  McpHttpError,
  McpSessionExpiredError,
  StreamableHttpTransport,
  type CallToolResult,
  type McpTransport,
  type ProgressNotification,
  type Root,
  type Tool,
} from '@earendil-works/pi-mcp';
import {
  completeMcpSignIn,
  createMcpAuthProvider,
  listenForLoopbackSignIn,
  McpOAuthAuthorizationRequiredError,
  startMcpSignIn,
  waitForLoopbackSignIn,
  type McpAuthProvider,
  type McpOAuthSettings,
  type OAuthChallenge,
} from '@earendil-works/pi-mcp/oauth';
import { PROTOCOL_VERSION, type McpServerDefinition } from '@piarc/protocol';

import type { CoreBridge } from '../runtime/core-bridge.js';
import { usesOAuth } from './config.js';
import { StdioServerTransport } from './stdio.js';
import { vaultStore } from './vault-store.js';

/** How PiArc introduces itself to servers and to authorization servers. */
export const CLIENT_NAME = 'PiArc';
/** Limit of `initialize` and `tools/list` (Claude Code's `MCP_TIMEOUT` default). */
export const CONNECT_TIMEOUT_MS = 30_000;
/** Characters of the stderr tail in an error. */
const ERROR_TAIL_CHARS = 1_000;

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'needsAuth' | 'failed';

/** What a connection needs from the pool. */
export interface ConnectionContext {
  /** The workspace root: stdio servers' working directory unless they name one. */
  readonly workspace: string;
  /** The environment stdio servers start from (Core's command environment). */
  readonly env: () => Readonly<Record<string, string>>;
  readonly bridge: CoreBridge;
  readonly log: (line: string) => void;
  /** The directories servers may work in (`roots/list`). */
  readonly roots: () => readonly Root[];
  /** Makes a transport instead of the real ones (tests). */
  readonly transport?: (def: McpServerDefinition, cwd: string) => McpTransport;
}

/** A user-facing message of an error. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The environment of a stdio server: the command environment, the bundled Node's directory
 * first on `PATH` (so `npx` runs without a system Node, architecture section 5.6), the Agent
 * Host's writable temporary and npm cache directories (Seatbelt allows writes there only),
 * then the definition's own variables. Nothing else of the Agent Host's environment.
 */
export function serverEnv(
  base: Readonly<Record<string, string>>,
  own: Readonly<Record<string, string>>,
  nodeBin: string = path.dirname(process.execPath),
): Record<string, string> {
  const env: Record<string, string> = { ...base };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [nodeBin, env[pathKey]]
    .filter((part) => part !== undefined && part !== '')
    .join(path.delimiter);
  for (const key of ['TMPDIR', 'TEMP', 'TMP', 'npm_config_cache', 'npm_config_update_notifier']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...own };
}

/** One prompt a server offers (MCP `prompts/list`, T40). */
export interface McpPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments: readonly {
    readonly name: string;
    readonly description?: string;
    readonly required: boolean;
  }[];
}

/** One message of `prompts/get`: its role and content as the server sent them. */
export interface McpPromptMessage {
  readonly role: string;
  readonly content: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The prompts of a `prompts/list` page; malformed entries are left out. */
export function parsePrompts(result: unknown): { prompts: McpPrompt[]; next?: string } {
  if (!isRecord(result) || !Array.isArray(result.prompts)) return { prompts: [] };
  const prompts: McpPrompt[] = [];
  for (const raw of result.prompts) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name === '') continue;
    const args = Array.isArray(raw.arguments) ? raw.arguments : [];
    prompts.push({
      name: raw.name,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      arguments: args.flatMap((arg) =>
        isRecord(arg) && typeof arg.name === 'string'
          ? [
              {
                name: arg.name,
                ...(typeof arg.description === 'string' ? { description: arg.description } : {}),
                required: arg.required === true,
              },
            ]
          : [],
      ),
    });
  }
  const next = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
  return next === undefined ? { prompts } : { prompts, next };
}

/** The most `prompts/list` pages read (a server that never stops paging). */
const MAX_PROMPT_PAGES = 20;

function toolsKey(tools: readonly Tool[]): string {
  return JSON.stringify(
    tools.map((tool) => [tool.name, tool.description ?? '', tool.inputSchema, tool._meta ?? null]),
  );
}

export class ServerConnection {
  state: ConnectionState = 'idle';
  error: string | undefined;
  tools: Tool[] = [];
  /** The server's prompts (T40); empty when it does not declare the capability. */
  prompts: McpPrompt[] = [];
  instructions: string | undefined;
  /** Whether the tools were listed at least once (the cache is meaningful). */
  listed = false;
  pid: number | undefined;
  readonly def: McpServerDefinition;
  readonly #context: ConnectionContext;
  readonly #changed: (tools: boolean) => void;
  readonly #auth: McpAuthProvider | undefined;
  #client: McpClient | undefined;
  #opening: Promise<McpClient> | undefined;
  #ended = false;
  #challenge: OAuthChallenge | undefined;

  constructor(
    def: McpServerDefinition,
    context: ConnectionContext,
    changed: (tools: boolean) => void,
  ) {
    this.def = def;
    this.#context = context;
    this.#changed = changed;
    const url = def.http?.url;
    this.#auth =
      url !== undefined && usesOAuth(def)
        ? createMcpAuthProvider({
            serverUrl: url,
            store: vaultStore(context.bridge, def.name, context.log),
            settings: () => this.#oauthSettings(),
            onChallenge: (challenge) => {
              this.#challenge = challenge;
            },
            clientName: CLIENT_NAME,
          })
        : undefined;
  }

  /** Whether the server signs in with OAuth. */
  get oauth(): boolean {
    return this.#auth !== undefined;
  }

  get connected(): boolean {
    return this.#client?.connectionState === 'connected';
  }

  /** The connected client, connecting first when needed. */
  client(): Promise<McpClient> {
    if (this.#ended) return Promise.reject(new Error(`MCP server "${this.def.name}" was closed`));
    const client = this.#client;
    if (client?.connectionState === 'connected') return Promise.resolve(client);
    this.#opening ??= this.#open().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  /** Calls `tool`; a session the server forgot is retried once on a new session. */
  async callTool(
    tool: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; onProgress?: (progress: ProgressNotification) => void },
  ): Promise<CallToolResult> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.client();
      try {
        return await client.callTool(tool, args, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
          // No limit unless the definition sets one: a long call ends with the user's interrupt.
          timeoutMs: this.def.timeoutMs ?? Number.POSITIVE_INFINITY,
        });
      } catch (error) {
        if (error instanceof McpSessionExpiredError && attempt === 1) {
          // The server restarted and forgot the session; it did not run the call.
          await this.#drop(client);
          continue;
        }
        if (this.#needsSignIn(error)) {
          await this.#drop(client);
          this.#set('needsAuth', undefined);
          throw new Error(
            `MCP server "${this.def.name}" needs a sign-in: open Settings → MCP and choose Sign in.`,
            { cause: error },
          );
        }
        throw error;
      }
    }
  }

  /** `prompts/get` of prompt `name` with `args`: the messages it answers. */
  async getPrompt(
    name: string,
    args: Readonly<Record<string, string>>,
  ): Promise<readonly McpPromptMessage[]> {
    const client = await this.client();
    const result = await client.request('prompts/get', { name, arguments: { ...args } });
    if (!isRecord(result) || !Array.isArray(result.messages)) {
      throw new Error(`MCP server "${this.def.name}" answered prompts/get without messages`);
    }
    return result.messages.flatMap((message) =>
      isRecord(message) && typeof message.role === 'string'
        ? [{ role: message.role, content: message.content }]
        : [],
    );
  }

  /** Disconnects; the next use connects again. Tools stay cached. */
  async disconnect(): Promise<void> {
    await this.#opening?.catch(() => undefined);
    const client = this.#client;
    this.#client = undefined;
    this.pid = undefined;
    await client?.close().catch(() => undefined);
    if (!this.#ended && this.state !== 'needsAuth') this.#set('idle', undefined);
  }

  /** Disconnects for good, waiting for a token refresh in flight to be saved. */
  async end(): Promise<void> {
    this.#ended = true;
    await this.disconnect();
    await this.#auth?.settled();
  }

  /** Tells a connected server that the roots changed. */
  rootsChanged(): void {
    if (this.connected) {
      this.#client?.notify('notifications/roots/list_changed').catch(() => undefined);
    }
  }

  /**
   * Signs in (OAuth authorization code with PKCE, discovery and dynamic client registration by
   * pi-mcp): the authorization page goes to `show`, the redirect arrives on a loopback port,
   * or the user pastes it (`paste`); the tokens go to the vault. Then reconnects.
   */
  async signIn(
    show: (url: string) => void,
    paste: (signal: AbortSignal) => Promise<string | undefined>,
    signal: AbortSignal,
  ): Promise<void> {
    const url = this.def.http?.url;
    if (url === undefined || this.#auth === undefined) {
      throw new Error(`MCP server "${this.def.name}" does not sign in with OAuth`);
    }
    const store = vaultStore(this.#context.bridge, this.def.name, this.#context.log);
    const settings = this.#oauthSettings();
    const { callback, redirectUrl } = await listenForLoopbackSignIn({
      serverUrl: url,
      store,
      settings,
    });
    try {
      const options = {
        serverUrl: url,
        store,
        settings,
        clientName: CLIENT_NAME,
        redirectUrl,
        signal,
        ...(this.#challenge === undefined ? {} : { challenge: this.#challenge }),
      };
      const start = await startMcpSignIn(options);
      if (start.kind === 'redirect') {
        show(start.authorizationUrl);
        const response = await waitForLoopbackSignIn({
          callback,
          authorization: start,
          promptForRedirectUrl: paste,
          signal,
        });
        await completeMcpSignIn({ ...options, authorization: start, response });
      }
    } finally {
      await callback.close();
    }
    this.#challenge = undefined;
    this.#set('idle', undefined);
    await this.disconnect();
    await this.client();
  }

  #oauthSettings(): McpOAuthSettings {
    const oauth = this.def.http?.oauth;
    if (oauth == null) return {};
    return {
      ...(oauth.clientId == null ? {} : { clientId: oauth.clientId }),
      ...(oauth.callbackPort == null ? {} : { callbackPort: oauth.callbackPort }),
      ...(oauth.scope == null ? {} : { scope: oauth.scope }),
      ...(oauth.authServerMetadataUrl == null
        ? {}
        : { authServerMetadataUrl: new URL(oauth.authServerMetadataUrl) }),
      // Without a pre-registered client, register one (PiArc publishes no metadata document).
      clientRegistration: 'dcr',
    };
  }

  #needsSignIn(error: unknown): boolean {
    if (error instanceof McpOAuthAuthorizationRequiredError) return true;
    if (this.#auth === undefined) return false;
    return (
      error instanceof McpAuthRequiredError ||
      (error instanceof McpHttpError && (error.status === 401 || error.status === 403))
    );
  }

  #set(state: ConnectionState, error: string | undefined, tools = false): void {
    this.state = state;
    this.error = error;
    this.#changed(tools);
  }

  async #drop(client: McpClient): Promise<void> {
    if (this.#client === client) {
      this.#client = undefined;
      this.pid = undefined;
    }
    await client.close().catch(() => undefined);
  }

  #transport(cwd: string): McpTransport {
    const { def } = this;
    if (this.#context.transport !== undefined) return this.#context.transport(def, cwd);
    if (def.http != null) {
      return new StreamableHttpTransport({
        url: def.http.url,
        headers: { ...def.http.headers },
        ...(this.#auth === undefined ? {} : { authProvider: this.#auth }),
      });
    }
    if (def.stdio == null) throw new Error(`MCP server "${def.name}" has no program or endpoint`);
    return new StdioServerTransport({
      command: def.stdio.command,
      args: def.stdio.args ?? [],
      cwd,
      env: serverEnv(this.#context.env(), def.stdio.env ?? {}),
    });
  }

  async #open(): Promise<McpClient> {
    this.#set(this.state === 'needsAuth' ? 'needsAuth' : 'connecting', undefined);
    const cwd = path.resolve(this.#context.workspace, this.def.stdio?.cwd ?? '.');
    const client = new McpClient({
      name: CLIENT_NAME,
      version: PROTOCOL_VERSION,
      requestTimeoutMs: CONNECT_TIMEOUT_MS,
      capabilities: { roots: { listChanged: true } },
      roots: () => this.#context.roots(),
    });
    let transport: McpTransport | undefined;
    try {
      transport = this.#transport(cwd);
      await client.connect(transport);
      client.onNotification('notifications/tools/list_changed', () => {
        void this.#refreshTools(client);
      });
      client.onNotification('notifications/prompts/list_changed', () => {
        void this.#refreshPrompts(client);
      });
      client.onClose(() => {
        this.#closed(client, transport);
      });
      const tools = client.serverCapabilities?.tools === undefined ? [] : await client.listTools();
      const prompts = await this.#listPrompts(client);
      if (this.#ended || client.connectionState !== 'connected') {
        throw new Error('the connection closed while it was being set up');
      }
      this.#client = client;
      this.pid = transport instanceof StdioServerTransport ? transport.pid : undefined;
      const instructions =
        client.instructions?.trim() === '' ? undefined : client.instructions?.trim();
      // The first listing is a change too: sessions that started before the server connected
      // (a sign-in, a retry) register its tools now.
      const changed =
        !this.listed ||
        toolsKey(tools) !== toolsKey(this.tools) ||
        instructions !== this.instructions;
      this.tools = tools;
      this.prompts = prompts;
      this.instructions = instructions;
      this.listed = true;
      this.#set('connected', undefined, changed);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      if (this.#needsSignIn(error)) {
        this.#set('needsAuth', undefined);
        throw new Error(`MCP server "${this.def.name}" needs a sign-in`, { cause: error });
      }
      const message = this.#failure(error, transport);
      this.#set('failed', message);
      throw new Error(`MCP server "${this.def.name}" failed to connect: ${message}`, {
        cause: error,
      });
    }
  }

  #failure(error: unknown, transport: McpTransport | undefined): string {
    const stderr = transport instanceof StdioServerTransport ? transport.stderr.trim() : '';
    let message = describe(error);
    if (stderr !== '') message += `\n${stderr.slice(-ERROR_TAIL_CHARS)}`;
    const command = this.def.stdio?.command;
    if (
      command !== undefined &&
      /^npx(\.cmd)?$/i.test(path.basename(command)) &&
      stderr.includes('EPERM')
    ) {
      // I40: inside the Agent Host's sandbox npm cannot link a package from a local directory.
      message +=
        '\nnpx cannot install a package from a local directory inside PiArc; pack it with `npm pack` and point npx at the .tgz file.';
    }
    return message;
  }

  #closed(client: McpClient, transport: McpTransport | undefined): void {
    if (this.#client !== client) return;
    this.#client = undefined;
    this.pid = undefined;
    if (this.#ended) return;
    const stderr = transport instanceof StdioServerTransport ? transport.stderr.trim() : '';
    // The next use reconnects; the pool retries while sessions need the server.
    this.#set(
      'failed',
      stderr === ''
        ? 'the connection closed'
        : `the connection closed\n${stderr.slice(-ERROR_TAIL_CHARS)}`,
    );
  }

  /** Every page of `prompts/list`, when the server declares prompts. */
  async #listPrompts(client: McpClient): Promise<McpPrompt[]> {
    if (client.serverCapabilities?.prompts === undefined) return [];
    const prompts: McpPrompt[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PROMPT_PAGES; page++) {
      const result = await client.request('prompts/list', cursor === undefined ? {} : { cursor });
      const parsed = parsePrompts(result);
      prompts.push(...parsed.prompts);
      if (parsed.next === undefined) break;
      cursor = parsed.next;
    }
    return prompts;
  }

  async #refreshPrompts(client: McpClient): Promise<void> {
    try {
      const prompts = await this.#listPrompts(client);
      if (this.#client !== client) return;
      this.prompts = prompts;
      // A state change: the status goes out and the client asks for the commands again.
      this.#changed(false);
    } catch (error) {
      this.#context.log(
        `MCP server "${this.def.name}": listing prompts again failed: ${describe(error)}`,
      );
    }
  }

  async #refreshTools(client: McpClient): Promise<void> {
    try {
      const tools = await client.listTools();
      if (this.#client !== client) return;
      const changed = toolsKey(tools) !== toolsKey(this.tools);
      this.tools = tools;
      if (changed) this.#changed(true);
    } catch (error) {
      this.#context.log(
        `MCP server "${this.def.name}": listing tools again failed: ${describe(error)}`,
      );
    }
  }
}
