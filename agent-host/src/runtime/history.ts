// The persisted conversation as items, for Core's `transcript_window` (`session/history`): the
// entries of the session's current branch, projected with the same builders and status rules
// as the live notifications (projector.ts, architecture section 5.3).
//
// | Pi entry                                  | Items                                         |
// |-------------------------------------------|-----------------------------------------------|
// | user message                              | userMessage (id: entry id)                    |
// | assistant message                         | agentMessage / reasoning per content block    |
// |                                           | (`<entry id>#<index>`), one tool item per     |
// |                                           | tool call (id: tool call id) with the status  |
// |                                           | and output of its tool result                 |
// | compaction                                | contextCompaction (no reason: Pi keeps none)  |
// | everything else                           | nothing                                       |
//
// A tool call without a result was interrupted; one in an aborted response never ran and is
// left out, as Pi leaves it out of the model's context. The interruption marker the Harness Kit
// adds after an interrupted turn (harness/interruption.ts) is bookkeeping for the model and is
// not shown.
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { HistoryItem, HistoryWindow, ItemStatus } from '@piarc/protocol';

import { isInterruptionMarker } from '../harness/interruption.js';
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

/** Every item of `branch` (root to leaf), in conversation order. */
export function projectHistory(
  branch: readonly SessionEntry[],
  toCanonical: (tool: string) => string,
): HistoryItem[] {
  const results = new Map<string, ToolResult>();
  for (const entry of branch) {
    if (entry.type === 'message' && entry.message.role === 'toolResult') {
      results.set(entry.message.toolCallId, {
        text: contentText(entry.message.content),
        isError: entry.message.isError,
        details: entry.message.details,
      });
    }
  }
  const items: HistoryItem[] = [];
  for (const entry of branch) {
    if (entry.type === 'compaction') {
      items.push({
        entryId: entry.id,
        item: contextCompaction(entry.id, 'completed', { tokensBefore: entry.tokensBefore }),
      });
      continue;
    }
    if (entry.type !== 'message') {
      continue;
    }
    const { message } = entry;
    if (message.role === 'user') {
      items.push({
        entryId: entry.id,
        item: userMessage(entry.id, contentText(message.content) ?? ''),
      });
    } else if (message.role === 'assistant' && !isInterruptionMarker(message)) {
      items.push(...assistantItems(entry.id, message, results, toCanonical));
    }
  }
  return items;
}

function assistantItems(
  entryId: string,
  message: Extract<SessionEntry, { type: 'message' }>['message'] & { role: 'assistant' },
  results: ReadonlyMap<string, ToolResult>,
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
      items.push({ entryId, item: agentMessage(itemId, textStatus, part.text.toWellFormed()) });
    } else if (part.type === 'thinking') {
      items.push({ entryId, item: reasoning(itemId, textStatus, part.thinking.toWellFormed()) });
    } else if (ran) {
      const result = results.get(part.id);
      const status: ItemStatus =
        result === undefined ? 'interrupted' : result.isError ? 'failed' : 'completed';
      items.push({
        entryId,
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
