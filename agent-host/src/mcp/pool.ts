// The workspace's shared MCP connection pool (architecture sections 5.2 and 6.8, ADR-0010,
// T36): one connection (one process for a stdio server) per configured server, shared by every
// session of the workspace, its subagents included.
//
// - Configuration: Core's `mcp/servers` (sources, trust, the user's choices, the command
//   environment). `refresh()` reads it again; a definition that changed replaces its
//   connection, a removed or disabled one is closed.
// - Leases: a session that opens takes a lease on every server that may run (`attach`); the
//   first lease connects the server. Its tools stay cached in the pool.
// - Idle: after `idleTimeoutMs` without a call in flight or a new lease, the server is
//   disconnected (its process exits); the next use connects it again. The clock is injectable.
// - Failures: while sessions hold leases, a failed server is retried with backoff (1 s doubling
//   to 60 s); a server that needs a sign-in waits for it.
// - Roots: the workspace root and the worktrees of open sessions, not a session's cwd: a
//   connection is shared across sessions in different worktrees.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CallToolResult, ProgressNotification, Root } from '@earendil-works/pi-mcp';
import type {
  McpConnectionState,
  McpServerDefinition,
  McpServerStatus,
  McpServersResult,
  McpStatus,
} from '@piarc/protocol';

import type { CoreBridge } from '../runtime/core-bridge.js';
import { AhpError } from '../protocol/errors.js';
import { definitionKey, parseServers } from './config.js';
import {
  ServerConnection,
  describe,
  type ConnectionContext,
  type McpPrompt,
  type McpPromptMessage,
} from './connection.js';

/** A clock the idle and retry timers run on; tests inject a manual one. */
export interface PoolClock {
  now(): number;
  /** Runs `run` after `ms`; the result cancels it. */
  after(ms: number, run: () => void): () => void;
}

export const SYSTEM_CLOCK: PoolClock = {
  now: () => Date.now(),
  after(ms, run) {
    const timer = setTimeout(run, ms);
    timer.unref();
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Backoff of retries while sessions need a failed server. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/** A change sessions react to: a server's tools or instructions (`tools`), or its state. */
export interface PoolChange {
  readonly server: string;
  readonly tools: boolean;
}

export interface PoolOptions {
  readonly workspace: string;
  readonly bridge: CoreBridge;
  readonly log: (line: string) => void;
  /** Sends `mcp/statusChanged`. */
  readonly notify: (status: McpStatus) => void;
  readonly clock?: PoolClock;
  /** Replaces the transports (tests). */
  readonly transport?: ConnectionContext['transport'];
}

class Entry {
  readonly connection: ServerConnection;
  readonly key: string;
  /** Sessions holding a lease. */
  readonly users = new Set<string>();
  inFlight = 0;
  lastUsed: number;
  cancelIdle: (() => void) | undefined;
  cancelRetry: (() => void) | undefined;
  attempt = 0;

  constructor(connection: ServerConnection, now: number) {
    this.connection = connection;
    this.key = definitionKey(connection.def);
    this.lastUsed = now;
  }

  get def(): McpServerDefinition {
    return this.connection.def;
  }
}

export class McpPool {
  readonly #o: PoolOptions;
  readonly #clock: PoolClock;
  /** The workspace's servers by name, and subagents' inline servers by `owner\0name`. */
  readonly #entries = new Map<string, Entry>();
  /** Configured servers that may not run (disabled, unsupported, untrusted), for the status. */
  #others: McpServerDefinition[] = [];
  #config: McpServersResult | undefined;
  #refreshing: Promise<void> | undefined;
  readonly #sessions = new Map<string, string>();
  readonly #listeners = new Set<(change: PoolChange) => void>();
  #notifyQueued = false;
  #roots = '';

  constructor(options: PoolOptions) {
    this.#o = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
  }

  /** MCP tools above this many in a session are deferred behind `ToolSearch`. */
  get deferThreshold(): number {
    return this.#config?.deferThreshold ?? 30;
  }

  /** Hears every change of a server's tools or state. */
  onChange(listener: (change: PoolChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Reads the configuration from Core again and applies it (also once at a time). */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /** The configuration has been read once (sessions wait for it before their first prompt). */
  async ready(): Promise<void> {
    if (this.#config === undefined) await this.refresh();
  }

  /** The prompts of the connected workspace servers (T40), by server. */
  prompts(): { readonly server: string; readonly prompts: readonly McpPrompt[] }[] {
    return this.servers()
      .filter((s) => s.connected && s.prompts.length > 0)
      .map((s) => ({ server: s.def.name, prompts: s.prompts }));
  }

  /** `prompts/get` on workspace server `server`. */
  async getPrompt(
    server: string,
    name: string,
    args: Readonly<Record<string, string>>,
  ): Promise<readonly McpPromptMessage[]> {
    const entry = this.#entries.get(server);
    if (!entry?.connection.connected) {
      throw new AhpError('invalidParams', `MCP server "${server}" is not connected`);
    }
    entry.inFlight++;
    try {
      return await entry.connection.getPrompt(name, args);
    } finally {
      entry.inFlight--;
      entry.lastUsed = this.#clock.now();
      this.#scheduleIdle(entry);
    }
  }

  /** The servers sessions may use (workspace servers that may run), by name. */
  servers(): readonly ServerConnection[] {
    return [...this.#entries.entries()]
      .filter(([key]) => !key.includes('\0'))
      .map(([, entry]) => entry.connection);
  }

  /** The connection of `name` (`owner` for a subagent's inline server). */
  server(name: string, owner?: string): ServerConnection | undefined {
    return (
      (owner === undefined ? undefined : this.#entries.get(`${owner}\0${name}`)?.connection) ??
      this.#entries.get(name)?.connection
    );
  }

  /** Session `id` (working in `cwd`) uses the workspace's servers: connects them. */
  attach(id: string, cwd: string): void {
    this.#sessions.set(id, cwd);
    for (const [key, entry] of this.#entries) {
      if (key.includes('\0')) continue;
      this.#lease(entry, id);
    }
    this.#rootsMaybeChanged();
  }

  /** Session `id` closed: its leases end, its inline servers close. */
  async detach(id: string): Promise<void> {
    this.#sessions.delete(id);
    const closing: Promise<void>[] = [];
    for (const [key, entry] of this.#entries) {
      entry.users.delete(id);
      if (key.startsWith(`${id}\0`)) {
        this.#entries.delete(key);
        closing.push(this.#close(entry));
      } else {
        this.#scheduleIdle(entry);
      }
    }
    this.#rootsMaybeChanged();
    this.#queueNotify();
    await Promise.all(closing);
  }

  /** A subagent's inline servers, for its run only (T36): connected for `owner`. */
  addTemporary(owner: string, defs: readonly McpServerDefinition[]): ServerConnection[] {
    const added: ServerConnection[] = [];
    for (const def of defs) {
      if (def.availability !== 'ready') {
        this.#o.log(
          `MCP server "${def.name}" of a subagent definition was not started: ${def.reason ?? def.availability}`,
        );
        continue;
      }
      const entry = this.#entry(def, `${owner}\0${def.name}`);
      this.#entries.set(`${owner}\0${def.name}`, entry);
      this.#lease(entry, owner);
      added.push(entry.connection);
    }
    this.#queueNotify();
    return added;
  }

  /** Calls a tool of `server` for session `id`; the call counts as use (no idle meanwhile). */
  async call(
    id: string,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: ProgressNotification) => void;
      toolCallId?: string;
    },
  ): Promise<CallToolResult> {
    const entry = this.#entries.get(`${id}\0${server}`) ?? this.#entries.get(server);
    if (entry === undefined) throw new Error(`MCP server "${server}" is not configured`);
    entry.inFlight++;
    entry.lastUsed = this.#clock.now();
    entry.cancelIdle?.();
    try {
      return await entry.connection.callTool(tool, args, {
        ...options,
        ...(options.toolCallId === undefined
          ? {}
          : { owner: { sessionId: id, toolCallId: options.toolCallId, serverTool: tool } }),
      });
    } finally {
      entry.inFlight--;
      entry.lastUsed = this.#clock.now();
      this.#scheduleIdle(entry);
    }
  }

  /** Waits until `server` connected or failed (connects it when idle). */
  async connected(server: string, owner?: string): Promise<void> {
    const entry =
      (owner === undefined ? undefined : this.#entries.get(`${owner}\0${server}`)) ??
      this.#entries.get(server);
    if (entry === undefined) return;
    entry.lastUsed = this.#clock.now();
    await entry.connection.client().catch(() => undefined);
    this.#scheduleIdle(entry);
  }

  /** The state of every configured server. */
  status(): McpStatus {
    const config = this.#config;
    const servers: McpServerStatus[] = [];
    for (const [key, entry] of this.#entries) {
      if (key.includes('\0')) continue;
      servers.push(this.#status(entry));
    }
    for (const def of this.#others) {
      servers.push({
        name: def.name,
        scope: def.scope,
        source: def.source,
        transport: def.transport,
        state: OTHER_STATES[def.availability],
        tools: 0,
        sessions: 0,
        ...(def.reason == null ? {} : { error: def.reason }),
      });
    }
    servers.sort((a, b) => a.name.localeCompare(b.name));
    return {
      servers,
      ...(config?.overridden?.length ? { overridden: config.overridden } : {}),
      ...(config?.issues?.length ? { issues: config.issues } : {}),
    };
  }

  /** One server's state; `notFound` when it is not configured. */
  statusOf(name: string): McpServerStatus {
    const found = this.status().servers.find((s) => s.name === name);
    if (found === undefined) {
      throw new AhpError('notFound', `no MCP server named ${name} is configured`);
    }
    return found;
  }

  /** `mcp/reconnect`: the configuration again, then a new connection. */
  async reconnect(name: string): Promise<McpServerStatus> {
    await this.refresh();
    const entry = this.#entries.get(name);
    if (entry !== undefined) {
      entry.cancelRetry?.();
      entry.attempt = 0;
      await entry.connection.disconnect();
      entry.lastUsed = this.#clock.now();
      await entry.connection.client().catch(() => undefined);
      this.#scheduleIdle(entry);
    }
    return this.statusOf(name);
  }

  /** `mcp/setEnabled`: Core stored the choice; the configuration says what follows. */
  async setEnabled(name: string): Promise<McpServerStatus> {
    await this.refresh();
    return this.statusOf(name);
  }

  /** Signs in to OAuth server `name` and reconnects it. */
  async signIn(
    name: string,
    show: (url: string) => void,
    paste: (signal: AbortSignal) => Promise<string | undefined>,
    signal: AbortSignal,
  ): Promise<McpServerStatus> {
    await this.refresh();
    const entry = this.#entries.get(name);
    if (entry === undefined) return this.statusOf(name);
    await entry.connection.signIn(show, paste, signal);
    entry.lastUsed = this.#clock.now();
    this.#scheduleIdle(entry);
    return this.statusOf(name);
  }

  /** Closes every connection (Agent Host shutdown). */
  async close(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => this.#close(entry)));
  }

  async #refresh(): Promise<void> {
    const raw = await this.#o.bridge.request('mcp/servers', {});
    const config = parseServers(raw);
    if (config === undefined) {
      throw new AhpError('invalidRequest', 'mcp/servers returned a malformed result');
    }
    this.#config = config;
    const ready = config.servers.filter((def) => def.availability === 'ready');
    this.#others = config.servers.filter((def) => def.availability !== 'ready');
    const closing: Promise<void>[] = [];
    for (const [key, entry] of this.#entries) {
      if (key.includes('\0')) continue;
      const next = ready.find((def) => def.name === key);
      if (next === undefined || definitionKey(next) !== entry.key) {
        this.#entries.delete(key);
        closing.push(this.#close(entry));
        this.#emit({ server: key, tools: true });
      }
    }
    for (const def of ready) {
      if (this.#entries.has(def.name)) continue;
      const entry = this.#entry(def, def.name);
      this.#entries.set(def.name, entry);
      for (const id of this.#sessions.keys()) this.#lease(entry, id);
      this.#emit({ server: def.name, tools: true });
    }
    this.#queueNotify();
    await Promise.all(closing);
  }

  #entry(def: McpServerDefinition, key: string): Entry {
    const context: ConnectionContext = {
      workspace: this.#o.workspace,
      env: () => this.#config?.env ?? {},
      bridge: this.#o.bridge,
      log: this.#o.log,
      roots: () => this.#rootList(),
      ...(this.#o.transport === undefined ? {} : { transport: this.#o.transport }),
    };
    const made: { entry?: Entry } = {};
    const connection = new ServerConnection(def, context, (tools) => {
      if (made.entry !== undefined) this.#changed(made.entry, key, tools);
    });
    made.entry = new Entry(connection, this.#clock.now());
    return made.entry;
  }

  #lease(entry: Entry, id: string): void {
    const first = entry.users.size === 0;
    entry.users.add(id);
    entry.lastUsed = this.#clock.now();
    if (first || !entry.connection.listed) {
      // The first session that needs the server connects it (and lists its tools).
      entry.connection.client().catch(() => undefined);
    }
    this.#scheduleIdle(entry);
    this.#queueNotify();
  }

  #changed(entry: Entry, key: string, tools: boolean): void {
    const { connection } = entry;
    if (connection.state === 'connected') {
      entry.attempt = 0;
      entry.cancelRetry?.();
      entry.cancelRetry = undefined;
    } else if (connection.state === 'failed' && entry.users.size > 0) {
      this.#retry(entry);
    }
    this.#scheduleIdle(entry);
    this.#emit({ server: key.includes('\0') ? key.slice(key.indexOf('\0') + 1) : key, tools });
    this.#queueNotify();
  }

  #retry(entry: Entry): void {
    if (entry.cancelRetry !== undefined) return;
    const delay = Math.min(RETRY_FIRST_MS * 2 ** entry.attempt, RETRY_MAX_MS);
    entry.attempt++;
    entry.cancelRetry = this.#clock.after(delay, () => {
      entry.cancelRetry = undefined;
      if (entry.users.size === 0 || entry.connection.state !== 'failed') return;
      entry.connection.client().catch((error: unknown) => {
        this.#o.log(
          `MCP server "${entry.def.name}" retry ${String(entry.attempt)}: ${describe(error)}`,
        );
      });
    });
  }

  #scheduleIdle(entry: Entry): void {
    entry.cancelIdle?.();
    entry.cancelIdle = undefined;
    if (!entry.connection.connected || entry.inFlight > 0) return;
    const idle = this.#config?.idleTimeoutMs ?? 600_000;
    const due = entry.lastUsed + idle - this.#clock.now();
    entry.cancelIdle = this.#clock.after(Math.max(0, due), () => {
      entry.cancelIdle = undefined;
      if (entry.inFlight > 0) return;
      if (this.#clock.now() - entry.lastUsed < idle) {
        this.#scheduleIdle(entry);
        return;
      }
      this.#o.log(`MCP server "${entry.def.name}" was idle for ${String(idle)} ms; disconnecting`);
      void entry.connection.disconnect();
    });
  }

  async #close(entry: Entry): Promise<void> {
    entry.cancelIdle?.();
    entry.cancelRetry?.();
    await entry.connection.end();
  }

  #status(entry: Entry): McpServerStatus {
    const { connection, def } = entry;
    const state: McpConnectionState = connection.state;
    return {
      name: def.name,
      scope: def.scope,
      source: def.source,
      transport: def.transport,
      state,
      tools: connection.tools.length,
      sessions: entry.users.size,
      ...(connection.error === undefined ? {} : { error: connection.error }),
      ...(connection.pid === undefined ? {} : { pid: connection.pid }),
      ...(connection.oauth ? { oauth: true } : {}),
    };
  }

  #emit(change: PoolChange): void {
    for (const listener of this.#listeners) listener(change);
  }

  #queueNotify(): void {
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    setImmediate(() => {
      this.#notifyQueued = false;
      this.#o.notify(this.status());
    });
  }

  /** The workspace root and the worktrees sessions work in (`.piarc/worktrees/<name>`). */
  #rootList(): Root[] {
    const roots = new Map<string, string>([[this.#o.workspace, path.basename(this.#o.workspace)]]);
    const base = path.join(this.#o.workspace, '.piarc', 'worktrees');
    for (const cwd of this.#sessions.values()) {
      const relative = path.relative(base, cwd);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const name = relative.split(path.sep)[0];
      if (name !== undefined && name !== '') roots.set(path.join(base, name), name);
    }
    return [...roots].map(([dir, name]) => ({ uri: pathToFileURL(dir).href, name }));
  }

  #rootsMaybeChanged(): void {
    const next = JSON.stringify(this.#rootList());
    if (next === this.#roots) return;
    const first = this.#roots === '';
    this.#roots = next;
    if (first) return;
    for (const entry of this.#entries.values()) entry.connection.rootsChanged();
  }
}

const OTHER_STATES: Record<McpServerDefinition['availability'], McpConnectionState> = {
  ready: 'idle',
  disabled: 'disabled',
  unsupported: 'unsupported',
  untrusted: 'untrusted',
};
