// The system reminder channel (architecture section 6.6.3, ADR-0042 rule 6, ADR-0043 rule 1):
// every runtime notice the model gets goes through here. A reminder has a type (protocol
// `ReminderType`), a source (a file, a hook event, a task) and its text; the producers:
//
// | type             | queued by                                   | key                    |
// | ---------------- | ------------------------------------------- | ---------------------- |
// | `todoStale`      | todos.ts (`todoWatch`)                      | `todo`                 |
// | `planMode`       | plan-mode.ts (mode menu)                    | `mode`                 |
// | `fileModified`   | file-changes.ts (Core `fs/changes`)         | `file:<path>`          |
// | `backgroundTask` | AHP `session/remind` (T32's tasks)          | `task:<id>`, `task:<n>`|
// | `monitorOutput`  | AHP `session/remind` (T32's Monitor)        | `monitor:<task id>`    |
// | `memoryLazyLoad` | session-memory.ts (subdirectories, changes) | `memory:<path>`        |
// | `rulesMatched`   | session-memory.ts (`paths:` rules)          | `memory:<path>`        |
// | `hookContext`    | hooks.ts (`additionalContext`, stdout)      | `hook:<event>:<n>`     |
// | `contextRestore` | compaction.ts (after a compaction)          | one message, appended  |
//
// A delivery is a Pi custom message (`piarc.reminder`, not displayed) whose text starts with
// `REMINDER_MARKER`, followed by the reminders' texts. `details.reminders` records each one's
// key, type, source, length and usage category, and what the type needs to replay (memory
// versions). It is persisted, so the conversation stays append-only and the system prompt and
// tool definitions never change (the provider's cache and the model's thinking blocks stay
// valid). Delivery points:
//
// - before a run starts (`before_agent_start`): after the user's message;
// - after a round of tool calls (`turn_end` with tool results): Pi 1.5.2 appends custom
//   messages queued while streaming right after that round's results, before the next model
//   request;
// - a compaction appends its message directly (compaction.ts), like a Stop hook's draft entry.
//
// Collectors (`fs/changes`) run before each delivery. Reminders queued under the same key
// replace each other; a key can be withdrawn while it is still queued.
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ReminderRef, ReminderType } from '@piarc/protocol';

import { isObject } from '../runtime/items.js';

/** Custom message type of the reminders. */
export const REMINDER_ENTRY = 'piarc.reminder';

/** First line of every reminder message; the Anthropic wire merges it into the adjacent user
 * turn. */
export const REMINDER_MARKER = '[PiArc reminder]';

/** Where a reminder counts in the context usage. */
export type ReminderCategory = 'memory' | 'skills' | 'conversation';

/** One reminder. */
export interface Reminder {
  readonly type: ReminderType;
  readonly source: string;
  readonly text: string;
  /** The usage category; `conversation` when absent. */
  readonly category?: ReminderCategory;
  /** What the type needs to replay from the branch (memory versions). */
  readonly data?: unknown;
}

/** A reminder with its queue key. */
export interface KeyedReminder extends Reminder {
  readonly key: string;
}

/** One reminder as recorded in a message's details. */
export interface ReminderRecord {
  readonly key: string;
  readonly type: ReminderType;
  readonly source: string;
  /** UTF-16 length of its text in the message. */
  readonly chars: number;
  readonly category: ReminderCategory;
  readonly data?: unknown;
}

/** A reminder message ready to be sent: Pi's custom message members. */
export interface ReminderMessage {
  readonly customType: typeof REMINDER_ENTRY;
  readonly display: false;
  readonly content: string;
  readonly details: {
    readonly keys: readonly string[];
    readonly reminders: readonly ReminderRecord[];
  };
}

interface Queued {
  readonly reminder: Reminder;
  readonly delivered?: () => void;
}

/** One message carrying `reminders`, in order. */
export function reminderMessage(reminders: readonly KeyedReminder[]): ReminderMessage {
  return {
    customType: REMINDER_ENTRY,
    display: false,
    content: [REMINDER_MARKER, ...reminders.map((r) => r.text)].join('\n\n'),
    details: {
      keys: reminders.map((r) => r.key),
      reminders: reminders.map((r) => ({
        key: r.key,
        type: r.type,
        source: r.source,
        chars: r.text.length,
        category: r.category ?? 'conversation',
        ...(r.data === undefined ? {} : { data: r.data }),
      })),
    },
  };
}

const TYPES: readonly ReminderType[] = [
  'todoStale',
  'fileModified',
  'planMode',
  'backgroundTask',
  'monitorOutput',
  'memoryLazyLoad',
  'rulesMatched',
  'hookContext',
  'contextRestore',
];
const CATEGORIES: readonly ReminderCategory[] = ['memory', 'skills', 'conversation'];

function isReminderType(value: unknown): value is ReminderType {
  return TYPES.some((type) => type === value);
}

function isCategory(value: unknown): value is ReminderCategory {
  return CATEGORIES.some((category) => category === value);
}

/** The reminders recorded in a `piarc.reminder` message's details; none when malformed. */
export function reminderRecords(details: unknown): ReminderRecord[] {
  if (!isObject(details) || !Array.isArray(details.reminders)) return [];
  const records: ReminderRecord[] = [];
  for (const r of details.reminders) {
    if (
      !isObject(r) ||
      typeof r.key !== 'string' ||
      !isReminderType(r.type) ||
      typeof r.source !== 'string' ||
      typeof r.chars !== 'number' ||
      !isCategory(r.category)
    ) {
      continue;
    }
    records.push({
      key: r.key,
      type: r.type,
      source: r.source,
      chars: r.chars,
      category: r.category,
      ...(r.data === undefined ? {} : { data: r.data }),
    });
  }
  return records;
}

/** The type and source of each reminder of a message, for its transcript item. */
export function reminderRefs(details: unknown): ReminderRef[] {
  return reminderRecords(details).map((r) => ({ type: r.type, source: r.source.toWellFormed() }));
}

/** The keys of a `piarc.reminder` message's details, or none. */
export function reminderKeys(details: unknown): readonly string[] {
  if (!isObject(details) || !('keys' in details)) return [];
  const { keys } = details;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
}

/** One session's queue of reminders. */
export class Reminders {
  readonly #queue = new Map<string, Queued>();
  readonly #collectors: ((signal?: AbortSignal) => Promise<void>)[] = [];
  #counter = 0;

  /** Queues `reminder` under `key`, replacing a queued one with the same key. `delivered`
   * runs once it is part of the conversation. */
  enqueue(key: string, reminder: Reminder, delivered?: () => void): void {
    this.#queue.delete(key);
    this.#queue.set(key, delivered === undefined ? { reminder } : { reminder, delivered });
  }

  /** A key of its own under `prefix`, for reminders that never replace each other. */
  uniqueKey(prefix: string): string {
    this.#counter += 1;
    return `${prefix}:${String(this.#counter)}`;
  }

  /** Drops a queued reminder that no longer applies. */
  withdraw(key: string): void {
    this.#queue.delete(key);
  }

  /** Whether a reminder is queued under `key`. */
  has(key: string): boolean {
    return this.#queue.has(key);
  }

  /** Runs `collect` before every delivery: it may queue reminders (files changed outside). */
  addCollector(collect: (signal?: AbortSignal) => Promise<void>): void {
    this.#collectors.push(collect);
  }

  async #collect(signal?: AbortSignal): Promise<void> {
    for (const collect of this.#collectors) await collect(signal);
  }

  /** Takes every queued reminder, in queue order. */
  takeAll(): KeyedReminder[] {
    const queued = [...this.#queue.entries()];
    this.#queue.clear();
    for (const [, item] of queued) item.delivered?.();
    return queued.map(([key, item]) => ({ key, ...item.reminder }));
  }

  /** Takes every queued reminder as one message, in queue order. */
  take(): ReminderMessage | undefined {
    const reminders = this.takeAll();
    return reminders.length === 0 ? undefined : reminderMessage(reminders);
  }

  /** Delivers the queue. Register it after the extensions that queue reminders at
   * `before_agent_start`, `tool_result` and `turn_end`. */
  extension: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', async (_event, ctx) => {
      await this.#collect(ctx.signal);
      const message = this.take();
      return message === undefined ? undefined : { message };
    });
    pi.on('turn_end', async (event, ctx) => {
      // A round without tool calls ends the run: the next run's start delivers the queue.
      if (event.toolResults.length === 0) return;
      await this.#collect(ctx.signal);
      const message = this.take();
      if (message !== undefined) pi.sendMessage(message, { triggerTurn: false });
    });
  };
}
