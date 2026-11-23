// One session's view of the workspace MCP pool (T36): PiArc's MCP extension, which replaces
// Pi's built-in one (SDK sessions load no built-in extension; PiArc adds this one instead, so
// neither Pi's MCP extension nor codemode is loaded). It
//
// - takes the session's leases on the pool's servers when the session starts, and gives them
//   back on `session_shutdown`;
// - registers each server's tools as `mcp__<server>__<tool>`: declared to the model (`direct`)
//   while the session has at most `deferThreshold` MCP tools, else `deferred` behind
//   `ToolSearch` (Pi's `tool_search`, registered under the canonical name with PiArc's
//   description); a server's `alwaysLoad` or a tool's `_meta["anthropic/alwaysLoad"]` keeps
//   tools declared;
// - waits, before the first prompt, for the servers being connected (at most
//   `STARTUP_WAIT_MS`), so their tools and instructions are in the frozen system prompt
//   (section 6); later changes are reminders (`mcpChanged`), the system prompt never changes;
// - answers which tools need the user on every call (`requiresUserInteraction`).
import { Type } from 'typebox';
import {
  createMcpToolName,
  mcpNamespace,
  normalizeMcpInputSchema,
  toLlmContent,
  type CallToolResult,
  type ProgressNotification,
  type Tool,
} from '@earendil-works/pi-mcp';
import {
  createToolSearchExtension,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { McpServerDefinition } from '@piarc/protocol';

import {
  MAX_DEFERRED_DESCRIPTION_CHARS,
  MAX_DIRECT_DESCRIPTION_CHARS,
  TOOL_SEARCH_DESCRIPTION,
  changeReminder,
  cut,
  mcpSection,
  type ServerNote,
} from '../harness/prompts/mcp.js';
import type { Reminders } from '../harness/reminders.js';
import { isObject } from '../runtime/items.js';
import type { ServerConnection } from './connection.js';
import type { McpPool, PoolChange } from './pool.js';

/** The canonical name of Pi's `tool_search`. */
export const TOOL_SEARCH = 'ToolSearch';
/** How long the first prompt waits for servers that are still connecting. */
export const STARTUP_WAIT_MS = 10_000;

type Exposure = 'direct' | 'deferred' | 'hidden';

interface Registered {
  readonly server: string;
  readonly tool: string;
  readonly exposure: Exposure;
  readonly interactive: boolean;
  readonly definition: ToolDefinition;
}

export interface McpSessionOptions {
  readonly pool: McpPool;
  readonly sessionId: string;
  readonly cwd: string;
  readonly reminders: Reminders;
  readonly log: (line: string) => void;
  /** A subagent definition's inline servers, for this session only. */
  readonly inline?: readonly McpServerDefinition[];
  /** Overrides the startup wait (tests). */
  readonly startupWaitMs?: number;
}

function meta(tool: Tool, key: string): unknown {
  const value: unknown = tool._meta;
  return isObject(value) ? value[`anthropic/${key}`] : undefined;
}

function progressText(progress: ProgressNotification): string {
  if (typeof progress.message === 'string' && progress.message !== '') return progress.message;
  const total = progress.total === undefined ? '' : `/${String(progress.total)}`;
  return `Progress ${String(progress.progress)}${total}`;
}

/** The model-facing content of an MCP result; an `isError` result is an error result. */
export function toolResult(
  server: string,
  tool: string,
  result: CallToolResult,
): {
  content: ReturnType<typeof toLlmContent>;
  details: { server: string; tool: string };
  isError?: true;
} {
  const content = toLlmContent(result);
  if (
    result.isError === true &&
    !content.some((block) => block.type === 'text' && block.text !== '')
  ) {
    content.push({ type: 'text', text: `MCP tool ${server}/${tool} reported an error.` });
  }
  return {
    content,
    details: { server, tool },
    ...(result.isError === true ? { isError: true } : {}),
  };
}

export class McpSession {
  readonly #o: McpSessionOptions;
  #pi: ExtensionAPI | undefined;
  readonly #registered = new Map<string, Registered>();
  /** Tool names each server offers now. */
  readonly #offered = new Map<string, Set<string>>();
  /** The instructions the model has of each server. */
  readonly #told = new Map<string, string | undefined>();
  /** The first prompt was prepared: changes are reminders from now on. */
  #started = false;
  #unsubscribe: (() => void) | undefined;

  constructor(options: McpSessionOptions) {
    this.#o = options;
  }

  /** Whether `tool` must ask the user on every call. */
  requiresUserInteraction(tool: string): boolean {
    return this.#registered.get(tool)?.interactive === true;
  }

  /** The system prompt's MCP section (section 6), or undefined. */
  systemSection(): string | undefined {
    const notes: ServerNote[] = this.#servers().map((server) => ({
      name: server.def.name,
      ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
      deferred: [...(this.#offered.get(server.def.name) ?? [])].some(
        (name) => this.#registered.get(name)?.exposure === 'deferred',
      ),
    }));
    for (const note of notes) this.#told.set(note.name, note.instructions);
    return mcpSection(notes);
  }

  extension: ExtensionFactory = (pi) => {
    this.#pi = pi;
    // Pi's tool_search under the canonical name, with PiArc's description. It searches the
    // tools whose exposure is `deferred` and activates the matches.
    void createToolSearchExtension()(
      new Proxy(pi, {
        get(target, property, receiver) {
          if (property === 'registerTool') {
            return (definition: ToolDefinition) => {
              target.registerTool({
                ...definition,
                name: TOOL_SEARCH,
                label: TOOL_SEARCH,
                description: TOOL_SEARCH_DESCRIPTION,
                promptSnippet: 'Find and load tools that are not loaded yet',
              });
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]): unknown => {
            const result: unknown = Reflect.apply(value, target, args);
            return result;
          };
        },
      }),
    );
    pi.on('session_start', async () => {
      const { pool } = this.#o;
      await pool.ready().catch((error: unknown) => {
        this.#o.log(`MCP configuration unavailable: ${String(error)}`);
      });
      pool.attach(this.#o.sessionId, this.#o.cwd);
      if (this.#o.inline !== undefined && this.#o.inline.length > 0) {
        pool.addTemporary(this.#o.sessionId, this.#o.inline);
      }
      this.#unsubscribe = pool.onChange((change) => {
        this.#changed(change);
      });
      this.#registerAll();
    });
    pi.on('before_agent_start', async (_event, ctx) => {
      if (this.#started) return;
      await this.#waitForServers(ctx.signal);
      this.#registerAll();
      this.#started = true;
    });
    pi.on('tool_call', async (event, ctx) => {
      // A search reaches every server: let the ones still connecting register their tools.
      if (event.toolName === TOOL_SEARCH) await this.#waitForServers(ctx.signal);
    });
    pi.on('session_shutdown', async () => {
      this.#unsubscribe?.();
      await this.#o.pool.detach(this.#o.sessionId);
    });
  };

  /** The servers of this session: the workspace's and its own inline ones. */
  #servers(): ServerConnection[] {
    const { pool, sessionId } = this.#o;
    const own = (this.#o.inline ?? [])
      .map((def) => pool.server(def.name, sessionId))
      .filter((server): server is ServerConnection => server !== undefined);
    const names = new Set(own.map((s) => s.def.name));
    return [...pool.servers().filter((s) => !names.has(s.def.name)), ...own];
  }

  async #waitForServers(signal: AbortSignal | undefined): Promise<void> {
    const pending = this.#servers().filter((s) => !s.listed && s.state === 'connecting');
    if (pending.length === 0) return;
    const wait = this.#o.startupWaitMs ?? STARTUP_WAIT_MS;
    await Promise.race([
      Promise.all(pending.map((s) => s.client().catch(() => undefined))),
      new Promise<void>((resolve) => setTimeout(resolve, wait).unref()),
      new Promise<void>((resolve) =>
        signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        ),
      ),
    ]);
  }

  #registerAll(): void {
    for (const server of this.#servers()) {
      if (server.listed) this.#register(server, false);
    }
  }

  #changed(change: PoolChange): void {
    if (!change.tools) return;
    const server = this.#servers().find((s) => s.def.name === change.server);
    if (server === undefined) {
      this.#withdraw(change.server, this.#started);
      return;
    }
    if (server.listed) this.#register(server, this.#started);
  }

  /** All MCP tools this session would declare or defer. */
  #toolCount(): number {
    return this.#servers().reduce((sum, server) => sum + server.tools.length, 0);
  }

  #register(server: ServerConnection, announce: boolean): void {
    const pi = this.#pi;
    if (pi === undefined) return;
    const name = server.def.name;
    const defer = this.#toolCount() > this.#o.pool.deferThreshold;
    const before = this.#offered.get(name) ?? new Set<string>();
    const offered = new Set<string>();
    const added: string[] = [];
    let deferredAdded = false;
    for (const tool of server.tools) {
      const toolName = createMcpToolName(name, tool.name, (candidate) => {
        const owner = this.#registered.get(candidate);
        return (
          (owner !== undefined && (owner.server !== name || owner.tool !== tool.name)) ||
          offered.has(candidate)
        );
      });
      offered.add(toolName);
      const previous = this.#registered.get(toolName);
      const always = server.def.alwaysLoad === true || meta(tool, 'alwaysLoad') === true;
      const exposure: Exposure =
        previous !== undefined && previous.exposure !== 'hidden'
          ? previous.exposure
          : defer && !always
            ? 'deferred'
            : 'direct';
      const definition = this.#definition(name, tool, toolName, exposure);
      pi.registerTool(definition);
      this.#registered.set(toolName, {
        server: name,
        tool: tool.name,
        exposure,
        interactive: meta(tool, 'requiresUserInteraction') === true,
        definition,
      });
      if (!before.has(toolName)) {
        added.push(toolName);
        if (exposure === 'deferred') deferredAdded = true;
      }
    }
    const removed = [...before].filter((toolName) => !offered.has(toolName));
    this.#hide(removed);
    this.#offered.set(name, offered);
    if ([...this.#registered.values()].some((r) => r.exposure === 'deferred')) {
      const active = pi.getActiveTools();
      if (!active.includes(TOOL_SEARCH)) pi.setActiveTools([...active, TOOL_SEARCH]);
    }
    if (!announce) return;
    const instructions = server.instructions;
    const newInstructions =
      instructions !== undefined && instructions !== this.#told.get(name)
        ? instructions
        : undefined;
    this.#told.set(name, instructions);
    if (added.length === 0 && removed.length === 0 && newInstructions === undefined) return;
    this.#o.reminders.enqueue(`mcp:${name}`, {
      type: 'mcpChanged',
      source: name,
      text: changeReminder({
        name,
        added,
        removed,
        deferred: deferredAdded,
        ...(newInstructions === undefined ? {} : { instructions: newInstructions }),
      }),
    });
  }

  /** A server left the configuration: its tools become unreachable. */
  #withdraw(name: string, announce: boolean): void {
    const removed = [...(this.#offered.get(name) ?? [])];
    this.#offered.delete(name);
    this.#told.delete(name);
    this.#hide(removed);
    if (announce && removed.length > 0) {
      this.#o.reminders.enqueue(`mcp:${name}`, {
        type: 'mcpChanged',
        source: name,
        text: changeReminder({ name, added: [], removed, deferred: false }),
      });
    }
  }

  /** Tools cannot be unregistered: withdrawn ones are registered again as hidden. */
  #hide(names: readonly string[]): void {
    const pi = this.#pi;
    if (pi === undefined || names.length === 0) return;
    for (const toolName of names) {
      const registered = this.#registered.get(toolName);
      if (registered === undefined) continue;
      pi.registerTool({ ...registered.definition, exposure: 'hidden' });
      this.#registered.set(toolName, { ...registered, exposure: 'hidden', interactive: false });
    }
    const hidden = new Set(names);
    pi.setActiveTools(pi.getActiveTools().filter((toolName) => !hidden.has(toolName)));
  }

  #definition(server: string, tool: Tool, name: string, exposure: Exposure): ToolDefinition {
    const { pool, sessionId } = this.#o;
    const description =
      tool.description?.trim() !== undefined && tool.description.trim() !== ''
        ? tool.description.trim()
        : (tool.title ?? `Tool ${tool.name} of MCP server ${server}.`);
    const def = pool.server(server, sessionId)?.def;
    return {
      name,
      label: `${server}/${tool.name}`,
      description: cut(
        description,
        exposure === 'deferred' ? MAX_DEFERRED_DESCRIPTION_CHARS : MAX_DIRECT_DESCRIPTION_CHARS,
      ),
      parameters: Type.Unsafe(normalizeMcpInputSchema(tool.inputSchema)),
      exposure,
      namespace: {
        name: mcpNamespace(server),
        aliases: [server],
        ...(def?.description == null ? {} : { description: def.description }),
      },
      async execute(toolCallId, params, signal, onUpdate) {
        const args = isObject(params) ? params : {};
        const result = await pool.call(sessionId, server, tool.name, args, {
          toolCallId,
          ...(signal === undefined ? {} : { signal }),
          onProgress: (progress) => {
            onUpdate?.({
              content: [{ type: 'text', text: progressText(progress) }],
              details: { server, tool: tool.name },
            });
          },
        });
        return toolResult(server, tool.name, result);
      },
    };
  }
}
