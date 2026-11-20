// The persisted conversation as items, for Core's `transcript_window` (`session/history`): the
// entries of the session's current branch, projected with the same builders and status rules
// as the live notifications (projector.ts, architecture section 5.3).
//
// | Pi entry                                  | Items                                         |
// |-------------------------------------------|-----------------------------------------------|
// | user message                              | userMessage (id: entry id), as the user wrote |
// |                                           | it when a `piarc.input` entry precedes it     |
// | assistant message                         | agentMessage / reasoning per content block    |
// |                                           | (`<entry id>#<index>`), one tool item per     |
// |                                           | tool call (id: tool call id) with the status  |
// |                                           | and output of its tool result                 |
// | compaction                                | contextCompaction (no reason: Pi keeps none)  |
// | `piarc.input` custom entry                | turn ID and any input data for the next user  |
// |                                           | message, or the following manual compaction   |
// | `piarc.reminder` custom message (with     | reminder (id: entry id)                       |
// |   `reminders`, capability `context`)      |                                               |
// | everything else                           | nothing                                       |
//
// A tool call without a result was interrupted; one in an aborted response never ran and is
// left out, as Pi leaves it out of the model's context. The interruption marker the Harness Kit
// adds after an interrupted turn (harness/interruption.ts) is bookkeeping for the model and is
// not shown.
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import type { HistoryItem, HistoryWindow, ItemStatus } from '@piarc/protocol';

import { isInterruptionMarker } from '../harness/interruption.js';
import { REMINDER_ENTRY, reminderRefs } from '../harness/reminders.js';
import { DECLINED_ENTRY } from '../harness/policy.js';
import { harnessState } from '../harness/session-harness.js';
import { SUBAGENT_STATE_ENTRY } from '../harness/subagents/definitions.js';
import { AhpError } from '../protocol/errors.js';
import { branchPoints } from './branches.js';
import { modeItem, modeRecord } from './permission-mode.js';
import { INPUT_ENTRY, parseInputRecord, type UserInput } from './input.js';
import {
  agentMessage,
  contentText,
  contextCompaction,
  isObject,
  reasoning,
  toolItem,
  userMessage,
} from './items.js';

/** The most items one `session/history` answer carries. */
export const MAX_HISTORY_LIMIT = 1000;

interface ToolResult {
  readonly text: string | undefined;
  readonly isError: boolean;
  readonly details: unknown;
}

interface InputRecord {
  readonly kind: 'user' | 'compact';
  readonly turnId: string | undefined;
  readonly input: UserInput | undefined;
}

/** Every item of `branch` (root to leaf), in conversation order. */
export function projectHistory(
  branch: readonly SessionEntry[],
  toCanonical: (tool: string) => string,
  reminders = false,
  summaries = false,
): HistoryItem[] {
  const results = new Map<string, ToolResult>();
  const declined = new Set<string>();
  // A subagent run's last state, recorded after its `Agent` result (T31).
  const runs = new Map<string, unknown>();
  for (const entry of branch) {
    if (
      entry.type === 'custom' &&
      entry.customType === SUBAGENT_STATE_ENTRY &&
      isObject(entry.data) &&
      typeof entry.data.itemId === 'string'
    ) {
      runs.set(entry.data.itemId, entry.data.subagent);
    }
    if (
      entry.type === 'custom' &&
      entry.customType === DECLINED_ENTRY &&
      isObject(entry.data) &&
      typeof entry.data.toolCallId === 'string'
    ) {
      declined.add(entry.data.toolCallId);
    }
    if (entry.type === 'message' && entry.message.role === 'toolResult') {
      results.set(entry.message.toolCallId, {
        text: contentText(entry.message.content),
        isError: entry.message.isError,
        details: entry.message.details,
      });
    }
  }
  for (const [id, run] of runs) {
    const result = results.get(id);
    if (result !== undefined) {
      results.set(id, {
        ...result,
        details: { ...(isObject(result.details) ? result.details : {}), subagent: run },
      });
    }
  }
  const items: HistoryItem[] = [];
  let pending: InputRecord | undefined;
  let currentTurn: string | undefined;
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === INPUT_ENTRY) {
      const data: unknown = entry.data;
      pending = {
        kind: isObject(data) && data.action === 'compact' ? 'compact' : 'user',
        turnId: isObject(data) && typeof data.turnId === 'string' ? data.turnId : undefined,
        input: parseInputRecord(data),
      };
      continue;
    }
    const record = modeRecord(entry);
    if (record !== undefined) {
      items.push({
        entryId: entry.id,
        turnId: record.turnId ?? entry.id,
        item: modeItem(entry.id, record.mode),
      });
      continue;
    }
    if (
      reminders &&
      entry.type === 'custom_message' &&
      entry.customType === REMINDER_ENTRY &&
      typeof entry.content === 'string'
    ) {
      items.push({
        entryId: entry.id,
        turnId: currentTurn ?? entry.id,
        item: {
          type: 'reminder',
          itemId: entry.id,
          status: 'completed',
          reminders: reminderRefs(entry.details),
          text: entry.content.toWellFormed(),
        },
      });
      continue;
    }
    if (summaries && entry.type === 'branch_summary') {
      // "Summarize from here" (T28): the conversation after this point is a summary.
      items.push({
        entryId: entry.id,
        turnId: currentTurn ?? entry.id,
        item: contextCompaction(entry.id, 'completed', { reason: 'rewind' }),
      });
      continue;
    }
    if (entry.type === 'compaction') {
      if (pending?.kind === 'compact') {
        currentTurn = pending.turnId;
        pending = undefined;
      }
      items.push({
        entryId: entry.id,
        turnId: currentTurn ?? entry.id,
        item: contextCompaction(entry.id, 'completed', { tokensBefore: entry.tokensBefore }),
      });
      continue;
    }
    if (entry.type !== 'message') {
      continue;
    }
    const { message } = entry;
    if (message.role === 'user') {
      const text = contentText(message.content) ?? '';
      // The record belongs to this message when the message starts with what the user wrote
      // (attached PDFs' text follows it).
      const record = pending?.kind === 'user' ? pending : undefined;
      const own = record?.input;
      const matches = own === undefined || text.startsWith(own.text);
      currentTurn = (matches ? record?.turnId : undefined) ?? entry.id;
      pending = undefined;
      items.push({
        entryId: entry.id,
        turnId: currentTurn,
        item: userMessage(entry.id, text, matches ? own : undefined),
      });
    } else if (message.role === 'assistant' && !isInterruptionMarker(message)) {
      items.push(
        ...assistantItems(
          entry.id,
          currentTurn ?? entry.id,
          message,
          results,
          declined,
          toCanonical,
        ),
      );
    }
  }
  return items;
}

function assistantItems(
  entryId: string,
  turnId: string,
  message: Extract<SessionEntry, { type: 'message' }>['message'] & { role: 'assistant' },
  results: ReadonlyMap<string, ToolResult>,
  declined: ReadonlySet<string>,
  toCanonical: (tool: string) => string,
): HistoryItem[] {
  const textStatus: ItemStatus =
    message.stopReason === 'aborted'
      ? 'interrupted'
      : message.stopReason === 'error'
        ? 'failed'
        : 'completed';
  const ran = message.stopReason !== 'aborted' && message.stopReason !== 'error';
  const items: HistoryItem[] = [];
  message.content.forEach((part, index) => {
    const itemId = `${entryId}#${String(index)}`;
    if (part.type === 'text') {
      items.push({
        entryId,
        turnId,
        item: agentMessage(itemId, textStatus, part.text.toWellFormed()),
      });
    } else if (part.type === 'thinking') {
      items.push({
        entryId,
        turnId,
        item: reasoning(itemId, textStatus, part.thinking.toWellFormed()),
      });
    } else if (ran) {
      const result = results.get(part.id);
      const status: ItemStatus =
        declined.has(part.id) ||
        (isObject(result?.details) && result.details.approvalExpired === true)
          ? 'declined'
          : result === undefined
            ? 'interrupted'
            : result.isError
              ? 'failed'
              : 'completed';
      items.push({
        entryId,
        turnId,
        item: toolItem(
          part.id,
          status,
          toCanonical(part.name),
          isObject(part.arguments) ? part.arguments : {},
          result?.text,
          result?.details,
        ),
      });
    }
  });
  return items;
}

/** Items `start .. start + limit` of `items`; the last `limit` when `start` is undefined. */
export function historyWindow(
  items: readonly HistoryItem[],
  start: number | undefined,
  limit: number,
): HistoryWindow {
  const total = items.length;
  const first = start === undefined ? Math.max(0, total - limit) : Math.min(start, total);
  return { start: first, total, items: items.slice(first, first + limit) };
}

/** Refuses a `session/history` limit outside 1 .. `MAX_HISTORY_LIMIT`. */
export function checkHistoryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new AhpError(
      'invalidParams',
      `session/history: limit must be between 1 and ${String(MAX_HISTORY_LIMIT)}`,
      { details: { member: 'limit' } },
    );
  }
}

/**
 * `session/history` of the session `manager` reads (`undefined`: no file yet): the window of
 * items, the branch's plan and task list, and its branch points (capability `checkpoints`).
 */
export function historyOf(
  manager: SessionManager | undefined,
  toCanonical: (tool: string) => string,
  capabilities: { readonly context?: boolean; readonly checkpoints?: boolean } | undefined,
  start: number | undefined,
  limit: number,
): HistoryWindow {
  const branch = manager?.getBranch() ?? [];
  const checkpoints = capabilities?.checkpoints === true;
  const window = historyWindow(
    projectHistory(branch, toCanonical, capabilities?.context === true, checkpoints),
    start,
    limit,
  );
  const harness = harnessState(branch, toCanonical);
  const branches = checkpoints && manager !== undefined ? branchPoints(manager) : [];
  return {
    ...window,
    ...(harness === undefined ? {} : { harness }),
    ...(branches.length === 0 ? {} : { branches }),
  };
}
