// Harness Kit: tool concurrency (architecture section 6.15, "工具并发"). Consecutive calls of
// concurrency-safe tools run in parallel batches of at most `MAX_BATCH`; any other call runs
// alone, after everything before it finished and before anything after it starts.
//
// Pi 1.5.2 runs a response's tool calls either all in parallel (no limit) or, when one tool is
// marked sequential, all one after another. So every tool runs in Pi's parallel mode and this
// scheduler holds each execution until its batch may start:
//
// - The plan comes from the response's tool calls in order (`plan`, from `message_end`).
// - A call is done when its execution ends or Pi reports its end (`done`, from
//   `tool_execution_end`), which covers calls Pi answered without running them (refused,
//   unknown tool, invalid arguments).
// - Batch k starts when every call of batches before k is done.
//
// Executions are wrapped where tools are defined: the canonical tools (session-registry.ts) and
// every extension's tools, including ones registered later such as MCP tools (`wrapExtensions`).
// Calls that are not in the plan (a tool calling another tool) run at once.
import type { LoadExtensionsResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** The most calls of one parallel batch. */
export const MAX_BATCH = 10;

/** Canonical tools that may run side by side: the read-only ones, and `Agent` (T31: each
 * subagent's own calls go through its own session's batches and permission checks). */
export const CONCURRENCY_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'Agent',
]);

/** The batches of `calls` (in response order): ids grouped, safe calls up to `MAX_BATCH`. */
export function planBatches(
  calls: readonly { readonly id: string; readonly name: string }[],
  isSafe: (name: string) => boolean,
): string[][] {
  const batches: string[][] = [];
  let open: string[] | undefined;
  for (const call of calls) {
    if (!isSafe(call.name)) {
      batches.push([call.id]);
      open = undefined;
      continue;
    }
    if (open === undefined || open.length >= MAX_BATCH) {
      open = [];
      batches.push(open);
    }
    open.push(call.id);
  }
  return batches;
}

/** Thrown to a call whose batch never came because the turn was interrupted. */
const ABORTED = 'Operation aborted';

export class ToolBatches {
  readonly #isSafe: (name: string) => boolean;
  /** Batch index of every planned call that is not done. */
  readonly #batchOf = new Map<string, number>();
  /** Calls not done, per batch. */
  #pending: number[] = [];
  #waiters: { readonly batch: number; readonly start: () => void }[] = [];
  #running = 0;
  #peak = 0;

  /** `isSafe` decides by the tool's name as the model called it. */
  constructor(isSafe: (name: string) => boolean) {
    this.#isSafe = isSafe;
  }

  /** The most executions that ran at once since the session started (for tests). */
  get peak(): number {
    return this.#peak;
  }

  /** Plans the tool calls of a new response, in response order. */
  plan(calls: readonly { readonly id: string; readonly name: string }[]): void {
    this.#release();
    const batches = planBatches(calls, this.#isSafe);
    this.#pending = batches.map((batch) => batch.length);
    batches.forEach((batch, index) => {
      for (const id of batch) {
        this.#batchOf.set(id, index);
      }
    });
  }

  /** Call `toolCallId` is done (it ran, or Pi answered it without running it). */
  done(toolCallId: string): void {
    const batch = this.#batchOf.get(toolCallId);
    if (batch === undefined) {
      return;
    }
    this.#batchOf.delete(toolCallId);
    this.#pending[batch] = (this.#pending[batch] ?? 1) - 1;
    this.#wake();
  }

  /** The turn ended: forget the plan and let every waiting call go (they see their abort). */
  clear(): void {
    this.#release();
  }

  /** `definition` with its execution held until its batch may start. */
  wrap<T extends ToolDefinition>(definition: T): T {
    const execute = definition.execute.bind(definition);
    const wrapped: ToolDefinition['execute'] = async (
      toolCallId,
      params,
      signal,
      onUpdate,
      ctx,
    ) => {
      await this.#enter(toolCallId, signal);
      this.#running += 1;
      this.#peak = Math.max(this.#peak, this.#running);
      try {
        return await execute(toolCallId, params, signal, onUpdate, ctx);
      } finally {
        this.#running -= 1;
        this.done(toolCallId);
      }
    };
    return { ...definition, execute: wrapped };
  }

  /**
   * For the resource loader's `extensionsOverride`: wraps the tools every extension registered
   * and the ones it registers later (Pi stores them in the extension's `tools` map).
   */
  wrapExtensions(result: LoadExtensionsResult): LoadExtensionsResult {
    for (const extension of result.extensions) {
      extension.tools = new SchedulingToolMap(this, extension.tools);
    }
    return result;
  }

  async #enter(toolCallId: string, signal: AbortSignal | undefined): Promise<void> {
    const batch = this.#batchOf.get(toolCallId);
    if (batch === undefined || this.#mayStart(batch)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new Error(ABORTED));
      };
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push({
        batch,
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      });
    });
  }

  #mayStart(batch: number): boolean {
    return this.#pending.slice(0, batch).every((count) => count <= 0);
  }

  #wake(): void {
    const ready = this.#waiters.filter((waiter) => this.#mayStart(waiter.batch));
    this.#waiters = this.#waiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) {
      waiter.start();
    }
  }

  #release(): void {
    this.#batchOf.clear();
    this.#pending = [];
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      waiter.start();
    }
  }
}

type RegisteredTools = LoadExtensionsResult['extensions'][number]['tools'];
type RegisteredTool = RegisteredTools extends Map<string, infer V> ? V : never;

/** An extension's tool map that wraps every tool stored in it. */
class SchedulingToolMap extends Map<string, RegisteredTool> {
  readonly #batches: ToolBatches;

  constructor(batches: ToolBatches, tools: RegisteredTools) {
    super();
    this.#batches = batches;
    for (const [name, tool] of tools) {
      this.set(name, tool);
    }
  }

  override set(name: string, tool: RegisteredTool): this {
    return super.set(name, { ...tool, definition: this.#batches.wrap(tool.definition) });
  }
}
