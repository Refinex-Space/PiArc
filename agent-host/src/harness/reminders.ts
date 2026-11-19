// Runtime notices for the model (architecture section 6.6.3): plan mode turning on or off, a
// task list that went stale. T26 introduces the module with one queue; T27 grows it into the
// general system-reminder channel (memory, hook context, files changed outside) on the same
// queue rather than starting another.
//
// A notice is a Pi custom message (`piarc.reminder`, not displayed) whose text starts with
// `REMINDER_MARKER`. It is persisted, so the conversation stays append-only and the system
// prompt and tool definitions never change (the provider's cache and the model's thinking
// blocks stay valid). Delivery points:
//
// - before a run starts (`before_agent_start`): after the user's message;
// - after a round of tool calls (`turn_end` with tool results): Pi 1.5.2 appends custom
//   messages queued while streaming right after that round's results, before the next model
//   request.
//
// Notices queued under the same key replace each other; a key can be withdrawn while it is
// still queued (plan mode switched on and off again before the model heard of it).
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/** Custom message type of the notices. */
export const REMINDER_ENTRY = 'piarc.reminder';

/** First line of every notice; the Anthropic wire merges it into the adjacent user turn. */
export const REMINDER_MARKER = '[PiArc reminder]';

interface Queued {
  readonly text: string;
  readonly delivered?: () => void;
}

/** A notice ready to be sent: Pi's custom message members. */
export interface ReminderMessage {
  readonly customType: typeof REMINDER_ENTRY;
  readonly display: false;
  readonly content: string;
  readonly details: { readonly keys: readonly string[] };
}

/** One session's queue of notices for the model. */
export class Reminders {
  readonly #queue = new Map<string, Queued>();

  /** Queues `text` under `key`, replacing a queued notice with the same key. `delivered` runs
   * once the notice is part of the conversation. */
  enqueue(key: string, text: string, delivered?: () => void): void {
    this.#queue.delete(key);
    this.#queue.set(key, delivered === undefined ? { text } : { text, delivered });
  }

  /** Drops a queued notice that no longer applies. */
  withdraw(key: string): void {
    this.#queue.delete(key);
  }

  /** Whether a notice is queued under `key`. */
  has(key: string): boolean {
    return this.#queue.has(key);
  }

  /** Takes every queued notice as one message, in queue order. */
  take(): ReminderMessage | undefined {
    if (this.#queue.size === 0) return undefined;
    const queued = [...this.#queue.entries()];
    this.#queue.clear();
    for (const [, notice] of queued) notice.delivered?.();
    return {
      customType: REMINDER_ENTRY,
      display: false,
      content: [REMINDER_MARKER, ...queued.map(([, notice]) => notice.text)].join('\n\n'),
      details: { keys: queued.map(([key]) => key) },
    };
  }

  /** Delivers the queue. Register it after the extensions that queue notices at `turn_end`. */
  extension: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', () => {
      const message = this.take();
      return message === undefined ? undefined : { message };
    });
    pi.on('turn_end', (event) => {
      // A round without tool calls ends the run: the next run's start delivers the queue.
      if (event.toolResults.length === 0) return;
      const message = this.take();
      if (message !== undefined) pi.sendMessage(message, { triggerTurn: false });
    });
  };
}

/** The keys of a `piarc.reminder` message's details, or none. */
export function reminderKeys(details: unknown): readonly string[] {
  if (typeof details !== 'object' || details === null || !('keys' in details)) return [];
  const { keys } = details;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
}
