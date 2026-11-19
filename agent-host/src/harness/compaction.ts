// Compaction (architecture section 6.6.4, T27, ADR-0043 rules 4–7). Pi 1.5.2 decides when to
// compact (manual `/compact`, the threshold, a context overflow) and where to cut; this module
// makes the rest PiArc's:
//
// - Settings: before every run (and after a model switch) the session's `SettingsManager`
//   gets `compaction.reserveTokens` for the threshold of compaction-threshold.ts and
//   `compaction.enabled` from `autoCompactEnabled` (Core's `context/settings`) and the circuit
//   breaker. Pi's `SettingsManager.reload()` drops in-memory overrides, so they are applied
//   again each time, with T14's `retry.provider.maxRetries = 0`.
// - Summary (`session_before_compact`): PreCompact hooks first (a block cancels), then PiArc's
//   sectioned summary request (prompts/compaction.ts) with the user's focus and the hooks'
//   instructions, on the session's model through its stream function (credentials resolve
//   through ModelRuntime), without prompt caching, retried per the session's retry settings.
//   A failed summary cancels the compaction (Pi would otherwise summarize with its own
//   prompt) and is reported as the compaction's failure.
// - Afterwards (`session_compact`): PostCompact and SessionStart (`compact`) hooks; Core
//   forgets the read ranges (`fs/forgetReads`, I72); one `contextRestore` reminder with what
//   reinjection.ts gives back (and whatever else was queued) is appended to the session, so the
//   next request carries it.
// - Circuit breaker: an automatic compaction that fails, or after which the context is still at
//   or above the threshold, counts; three in a row stop automatic compaction for the session
//   (the compaction item says why). An effective automatic compaction clears the count; a
//   successful manual one also re-enables it.
import { randomUUID } from 'node:crypto';

import {
  convertToLlm,
  serializeConversation,
  type AgentSession,
  type ExtensionFactory,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';
import {
  contentText,
  normalizeContext,
  retryAssistantCall,
  type Api,
  type Model,
} from '@earendil-works/pi-ai';
import type { AutoCompactStop, ContextSettings } from '@piarc/protocol';

import { describeError } from '../protocol/errors.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import type { CoreIo } from '../tools/core-io.js';
import {
  autoCompactThreshold,
  effectiveWindow,
  piReserveTokens,
  type ThresholdInput,
} from './compaction-threshold.js';
import type { ContextUsageTracker, UsageLimits } from './context-usage.js';
import type { SessionHooks } from './hooks.js';
import { currentPlan } from './plan-mode.js';
import { fileLists, SUMMARY_SYSTEM, summaryPrompt } from './prompts/compaction.js';
import { invokedSkills, recentFiles, restoreSections, type RestoredRead } from './reinjection.js';
import {
  REMINDER_ENTRY,
  reminderMessage,
  type ReminderMessage,
  type Reminders,
} from './reminders.js';
import type { SessionMemory } from './session-memory.js';
import { currentTodos } from './todos.js';

/** Automatic compactions in a row that fail or leave the context above the threshold before
 * automatic compaction stops. */
export const AUTO_COMPACT_FAILURE_LIMIT = 3;

/** What the projector adds to the compaction item that just ended. */
export interface CompactionNote {
  /** The summary request failed: the compaction failed with this message. */
  readonly failure?: string;
  /** The estimated context after the compaction and its restore. */
  readonly tokensAfter?: number;
  /** Automatic compaction stopped after this compaction. */
  readonly stopped?: AutoCompactStop;
}

export interface SessionCompactionOptions {
  readonly sessionId: string;
  readonly manager: SessionManager;
  readonly cwd: string;
  readonly session: () => AgentSession | undefined;
  readonly reminders: Reminders;
  readonly memory: SessionMemory;
  readonly canonical: (tool: string) => string;
  readonly usage: () => ContextUsageTracker;
  /** Core, when it enabled the `context` capability. */
  readonly bridge: CoreBridge | undefined;
  /** The session's delegated I/O (restored files), absent with Pi's own tools. */
  readonly io: CoreIo | undefined;
  readonly hooks: SessionHooks | undefined;
  /** The restore message was appended to the session (its transcript item). */
  readonly appended: (message: ReminderMessage) => void;
  readonly log: (line: string) => void;
}

function parseSettings(value: unknown): ContextSettings | undefined {
  if (!isObject(value) || typeof value.autoCompactEnabled !== 'boolean') return undefined;
  const window = value.autoCompactWindow;
  if (
    window != null &&
    (typeof window !== 'number' || !Number.isSafeInteger(window) || window <= 0)
  )
    return undefined;
  return {
    autoCompactEnabled: value.autoCompactEnabled,
    ...(typeof window === 'number' ? { autoCompactWindow: window } : {}),
  };
}

/** Read and modified files of the summarized messages, with those of the previous compaction. */
function fileOperations(
  event: SessionBeforeCompactEvent,
  canonical: (tool: string) => string,
): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set<string>();
  const modified = new Set<string>();
  const previous = event.branchEntries.findLast((entry) => entry.type === 'compaction');
  if (previous?.type === 'compaction' && isObject(previous.details)) {
    const { readFiles, modifiedFiles } = previous.details;
    if (Array.isArray(readFiles)) for (const f of readFiles) if (typeof f === 'string') read.add(f);
    if (Array.isArray(modifiedFiles))
      for (const f of modifiedFiles) if (typeof f === 'string') modified.add(f);
  }
  const { messagesToSummarize, turnPrefixMessages } = event.preparation;
  for (const message of [...messagesToSummarize, ...turnPrefixMessages]) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'toolCall' || typeof part.arguments.path !== 'string') continue;
      const tool = canonical(part.name);
      if (tool === 'Read') read.add(part.arguments.path);
      else if (tool === 'Write' || tool === 'Edit') modified.add(part.arguments.path);
    }
  }
  return {
    readFiles: [...read].filter((f) => !modified.has(f)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

/** PiArc's summary of `event.preparation` on `session`'s model. */
async function summarize(
  session: AgentSession,
  event: SessionBeforeCompactEvent,
  instructions: { focus?: string; hookInstructions?: string },
  canonical: (tool: string) => string,
) {
  const model: Model<Api> | undefined = session.model;
  if (model === undefined) throw new Error('No model is selected');
  const { preparation } = event;
  const transcript = serializeConversation(convertToLlm(preparation.messagesToSummarize));
  const prefix =
    preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0
      ? serializeConversation(convertToLlm(preparation.turnPrefixMessages))
      : undefined;
  const text = summaryPrompt({
    transcript,
    ...(prefix === undefined ? {} : { turnStart: prefix }),
    ...(preparation.previousSummary === undefined
      ? {}
      : { previousSummary: preparation.previousSummary }),
    ...instructions,
  });
  const level = session.thinkingLevel;
  const options = {
    signal: event.signal,
    // A one-off request: no cache write, a routing id of its own.
    cacheRetention: 'none' as const,
    sessionId: randomUUID(),
    ...(model.reasoning && level !== 'off' ? { reasoning: level } : {}),
  };
  const context = normalizeContext({
    systemPrompt: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }],
  });
  const stream = session.agent.streamFunction;
  const response = await retryAssistantCall(
    async () => (await stream(model, context, options)).result(),
    session.settingsManager.getRetrySettings(),
    event.signal,
  );
  if (response.stopReason === 'error' || response.stopReason === 'aborted') {
    throw new Error(response.errorMessage ?? 'the summary request failed');
  }
  if (response.stopReason === 'length') {
    throw new Error('the summary reached the output limit and is incomplete');
  }
  if (response.content.some((block) => block.type === 'toolCall')) {
    throw new Error('the summary request called a tool');
  }
  const files = fileOperations(event, canonical);
  return {
    summary: contentText(response.content).trim() + fileLists(files.readFiles, files.modifiedFiles),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: response.usage,
    details: files,
  };
}

/** One session's compaction settings, summary, restore and circuit breaker. */
export class SessionCompaction {
  readonly #o: SessionCompactionOptions;
  #settings: ContextSettings | undefined;
  /** Automatic compactions in a row that failed or were ineffective, and the last kind. */
  #strikes = 0;
  #strike: AutoCompactStop = 'failed';
  #stopped: AutoCompactStop | undefined;
  /** This compaction's summary failure, its context afterwards, the note for its item. */
  #failure: string | undefined;
  #lastFailure: string | undefined;
  #after: number | undefined;
  #note: CompactionNote | undefined;

  constructor(options: SessionCompactionOptions) {
    this.#o = options;
  }

  #input(): ThresholdInput | undefined {
    const model = this.#o.session()?.model;
    if (model === undefined) return undefined;
    return {
      contextWindow: model.contextWindow,
      maxOutput: model.maxTokens,
      ...(this.#settings?.autoCompactWindow == null
        ? {}
        : { autoCompactWindow: this.#settings.autoCompactWindow }),
    };
  }

  /** What the context usage is measured against. */
  limits(): UsageLimits {
    const input = this.#input();
    return {
      contextWindow: input === undefined ? 0 : effectiveWindow(input),
      autoCompactThreshold: input === undefined ? 0 : autoCompactThreshold(input),
      autoCompact:
        this.#stopped !== undefined
          ? 'stopped'
          : this.#settings?.autoCompactEnabled === false
            ? 'off'
            : 'on',
      ...(this.#stopped === undefined ? {} : { autoCompactStopped: this.#stopped }),
    };
  }

  /** Before a run or a manual compaction: Core's settings, then the session's overrides. */
  async prepare(signal?: AbortSignal): Promise<void> {
    const { bridge } = this.#o;
    if (bridge !== undefined) {
      try {
        this.#settings = await bridge.requestTyped(
          'context/settings',
          { sessionId: this.#o.sessionId },
          parseSettings,
          signal === undefined ? {} : { signal },
        );
      } catch (error) {
        this.#o.log(`context/settings failed, keeping the last settings: ${describeError(error)}`);
      }
    }
    this.apply();
  }

  /** Applies the threshold, the switch and the retry setting to the session's settings. */
  apply(): void {
    const session = this.#o.session();
    const input = this.#input();
    const model = session?.model;
    if (session === undefined) return;
    const retry = { provider: { maxRetries: 0 } };
    if (input === undefined || model === undefined) {
      session.settingsManager.applyOverrides({ retry });
      return;
    }
    const reserveTokens = piReserveTokens(model.contextWindow, autoCompactThreshold(input));
    session.settingsManager.applyOverrides({
      retry,
      compaction: {
        enabled: this.#settings?.autoCompactEnabled !== false && this.#stopped === undefined,
        reserveTokens,
        modelOverrides: { [`${model.provider}/${model.id}`]: { reserveTokens } },
      },
    });
  }

  /** The note for the compaction item that just ended, once. */
  takeNote(): CompactionNote | undefined {
    const note = this.#note;
    this.#note = undefined;
    return note;
  }

  /** Why the latest compaction's summary failed, until the next compaction starts (the
   * error of a `/compact` turn). */
  get lastFailure(): string | undefined {
    return this.#lastFailure;
  }

  /** Counts the compaction that just ended (before it is projected). */
  ended(event: { reason: string; aborted: boolean; result?: unknown }): void {
    const failure = this.#failure;
    const wasStopped = this.#stopped;
    const succeeded = event.result !== undefined;
    const note: { -readonly [K in keyof CompactionNote]: CompactionNote[K] } = {};
    if (failure !== undefined) note.failure = failure;
    if (succeeded && this.#after !== undefined) note.tokensAfter = this.#after;
    if (event.reason === 'manual') {
      if (succeeded) {
        this.#strikes = 0;
        this.#stopped = undefined;
      }
    } else {
      const threshold = this.limits().autoCompactThreshold;
      if (failure !== undefined || (!event.aborted && !succeeded)) {
        this.#strikes += 1;
        this.#strike = 'failed';
      } else if (succeeded && (this.#after ?? 0) >= threshold) {
        this.#strikes += 1;
        this.#strike = 'ineffective';
      } else if (succeeded) {
        this.#strikes = 0;
      }
      if (this.#stopped === undefined && this.#strikes >= AUTO_COMPACT_FAILURE_LIMIT) {
        this.#stopped = this.#strike;
        note.stopped = this.#strike;
        this.#o.log(
          `automatic compaction stopped: ${this.#strike} ${String(this.#strikes)} times in a row`,
        );
      }
    }
    this.apply();
    this.#note = Object.keys(note).length === 0 ? undefined : note;
    this.#lastFailure = failure;
    this.#failure = undefined;
    this.#after = undefined;
    // The usage card shows whether automatic compaction runs.
    if (this.#stopped !== wasStopped) this.#o.usage().compacted();
  }

  async #restore() {
    const entries: readonly SessionEntry[] = this.#o.manager.getBranch();
    const io = this.#o.io;
    const memory = await this.#o.memory.restore().catch((error: unknown) => {
      this.#o.log(`memory restore failed: ${describeError(error)}`);
      return [];
    });
    const sections = await restoreSections({
      memory,
      plan: currentPlan(entries),
      todos: currentTodos(entries, this.#o.canonical),
      skills: invokedSkills(entries),
      files: io === undefined ? [] : recentFiles(entries, this.#o.canonical, this.#o.cwd),
      readFile: async (file, maxChars): Promise<RestoredRead> => {
        if (io === undefined) return { kind: 'unreadable' };
        try {
          const text = await io.restoreText(file, maxChars);
          return text === undefined ? { kind: 'tooLong' } : { kind: 'text', text };
        } catch {
          return { kind: 'unreadable' };
        }
      },
    });
    this.#o.memory.restored(sections.filter((section) => section.category === 'memory'));
    return sections;
  }

  extension: ExtensionFactory = (pi) => {
    pi.on('session_before_compact', async (event) => {
      this.#failure = undefined;
      this.#lastFailure = undefined;
      this.#after = undefined;
      const trigger = event.reason === 'manual' ? 'manual' : 'auto';
      let hookInstructions: string | undefined;
      if (this.#o.hooks !== undefined) {
        const result = await this.#o.hooks.preCompact(trigger, event.customInstructions);
        if (result.block !== undefined) return { cancel: true };
        hookInstructions = result.instructions;
      }
      const session = this.#o.session();
      try {
        if (session === undefined) throw new Error('The session is not open');
        const focus = event.customInstructions?.trim();
        const compaction = await summarize(
          session,
          event,
          {
            ...(focus === undefined || focus === '' ? {} : { focus }),
            ...(hookInstructions === undefined || hookInstructions === ''
              ? {}
              : { hookInstructions }),
          },
          this.#o.canonical,
        );
        return { compaction };
      } catch (error) {
        if (!event.signal.aborted) {
          this.#failure = describeError(error);
          this.#o.log(`compaction summary failed: ${this.#failure}`);
        }
        // Cancelled rather than thrown: Pi would summarize with its own prompt instead.
        return { cancel: true };
      }
    });

    pi.on('session_compact', async (event) => {
      const trigger = event.reason === 'manual' ? 'manual' : 'auto';
      await this.#o.hooks?.postCompact(trigger, event.compactionEntry.summary);
      if (this.#o.bridge !== undefined) {
        await this.#o.bridge
          .requestTyped('fs/forgetReads', { sessionId: this.#o.sessionId }, (value) =>
            isObject(value) ? value : undefined,
          )
          .catch((error: unknown) => {
            this.#o.log(`fs/forgetReads failed: ${describeError(error)}`);
          });
      }
      const sections = await this.#restore();
      // Reminders queued meanwhile (a SessionStart hook's context) go with it.
      const message = reminderMessage([...sections, ...this.#o.reminders.takeAll()]);
      // Pi builds every request from the session's entries: the next one carries it.
      this.#o.manager.appendCustomMessageEntry(
        REMINDER_ENTRY,
        message.content,
        message.display,
        message.details,
      );
      this.#o.appended(message);
      this.#after = this.#o.usage().compacted().tokens;
    });
  };
}
