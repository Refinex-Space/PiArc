// Projection of Pi session events onto AHP notifications (architecture section 5.3). The rules,
// row by row:
//
// | Pi event                                   | AHP notification                              |
// |--------------------------------------------|-----------------------------------------------|
// | first `agent_start` of an accepted input   | `turn/started`                                |
// | `agent_settled`                            | `turn/completed` with the turn's usage        |
// | `message_start` of a user message          | `item/started` + `item/completed` userMessage |
// | `message_update` text / thinking           | `item/started`, `item/agentMessage/delta` /   |
// |                                            | `item/reasoning/delta`, `item/completed`      |
// | `tool_execution_start/update/end`          | `item/started`, `item/updated`,               |
// |                                            | `item/completed` (tool item types, items.ts)  |
// | `compaction_start/end`                     | contextCompaction `item/started`/`completed`  |
// | `auto_retry_start`                         | `turn/retrying`                               |
// | `queue_update`                             | `session/queueChanged` (queue.ts, ids added)  |
// | `entry_appended` of a `piarc.*` custom     | `harness/entry`                               |
// |   entry (Harness Kit)                      |                                               |
//
// Item status: a tool's success or failure is its own result (`isError`): a Grep without matches
// is a success, a thrown error a failure; the projector never reads exit codes. A call the
// policy gate refused is `declined` (`markDeclined`); a call still open when the turn is
// interrupted, or one that failed after the abort, is `interrupted`.
//
// `messageId` is generated here when an assistant message starts streaming: Pi assigns the
// session entry id only when the message is persisted, after the deltas went out. Text and
// reasoning items are `<messageId>#<contentIndex>`; tool items are the tool call id.
//
// Strings sent to Core must be well-formed UTF-16 (the Rust side rejects lone surrogates, I08).
// A model's text delta can end between the two halves of a surrogate pair; the high half is held
// back and sent with the next delta. Any surrogate still unpaired becomes U+FFFD.
import { randomUUID } from 'node:crypto';

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Item, ItemStatus, TurnStatus, TurnUsage } from '@piarc/protocol';

import {
  addUsage,
  agentMessage,
  contentText,
  contextCompaction,
  isObject,
  NO_USAGE,
  reasoning,
  resultText,
  toolItem,
  userMessage,
} from './items.js';

/** Where projected notifications go (the outbound queue, bound to one session). */
export interface ProjectionSink {
  event(method: string, payload: Record<string, unknown>): void;
  delta(method: string, mergeKey: string, payload: Record<string, unknown>, delta: string): void;
  /** A notification that supersedes a waiting one with the same key (`item/updated`). */
  replaceable(method: string, key: string, payload: Record<string, unknown>): void;
}

/** Prefix of the custom entry types the Harness Kit writes; they become `harness/entry`. */
export const HARNESS_ENTRY_PREFIX = 'piarc.';

type StreamKind = 'text' | 'reasoning';

interface OpenStream {
  readonly kind: StreamKind;
  readonly itemId: string;
  text: string;
  /** A trailing high surrogate held back from the last delta. */
  pendingHigh: string;
}

interface OpenTool {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

interface Turn {
  readonly turnId: string;
  started: boolean;
  aborting: boolean;
  messageId: string | undefined;
  userMessages: number;
  compactions: number;
  readonly streams: Map<number, OpenStream>;
  readonly tools: Map<string, OpenTool>;
  /** Tool calls the latest assistant message made, in order: calls Pi never started are
   * completed as interrupted when the turn is. */
  calls: { readonly id: string; readonly name: string; args: Record<string, unknown> }[];
  readonly finished: Set<string>;
  openCompaction: string | undefined;
  usage: TurnUsage;
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
}

export class Projector {
  readonly #sink: ProjectionSink;
  readonly #toCanonical: (tool: string) => string;
  readonly #declined = new Set<string>();
  #turn: Turn | undefined;

  /** `toCanonical` maps the model-visible tool names of the session's Tool Profile to canonical
   * names: Core sees canonical names only (architecture section 6.1.1). */
  constructor(sink: ProjectionSink, toCanonical: (tool: string) => string = (tool) => tool) {
    this.#sink = sink;
    this.#toCanonical = toCanonical;
  }

  /** The turn accepted for the current input, until it completes. */
  get activeTurnId(): string | undefined {
    return this.#turn?.turnId;
  }

  /** Accepts an input: its events will belong to `turnId`. */
  beginTurn(turnId: string): void {
    this.#turn = {
      turnId,
      started: false,
      aborting: false,
      messageId: undefined,
      userMessages: 0,
      compactions: 0,
      streams: new Map(),
      tools: new Map(),
      calls: [],
      finished: new Set(),
      openCompaction: undefined,
      usage: NO_USAGE,
      lastStopReason: undefined,
      lastErrorMessage: undefined,
    };
  }

  /** The running turn is being interrupted: tool calls that fail from now on are `interrupted`. */
  markAborting(): void {
    if (this.#turn !== undefined) {
      this.#turn.aborting = true;
    }
  }

  /** The policy gate refused tool call `toolCallId`: its item completes as `declined`. */
  markDeclined(toolCallId: string): void {
    this.#declined.add(toolCallId);
  }

  /**
   * Completes turn `turnId` if it is still open: Pi did not settle it (the prompt failed before
   * the agent started, or it was cancelled before it ran). A turn that already completed, or a
   * later turn, is left alone.
   */
  finishTurn(turnId: string, status: TurnStatus, errorMessage?: string): void {
    const turn = this.#turn;
    if (turn?.turnId !== turnId) {
      return;
    }
    this.#startTurn(turn);
    this.#closeOpenItems(turn, status === 'interrupted' ? 'interrupted' : 'failed');
    this.#completeTurn(turn, status, errorMessage);
  }

  /** Projects one Pi session event. Turn events outside an accepted turn are ignored. */
  handle(event: AgentSessionEvent): void {
    if (event.type === 'entry_appended') {
      this.#onEntry(event.entry);
      return;
    }
    const turn = this.#turn;
    if (turn === undefined) {
      return;
    }
    switch (event.type) {
      case 'agent_start':
        this.#startTurn(turn);
        break;
      case 'message_start':
        this.#onMessageStart(turn, event.message);
        break;
      case 'message_update':
        this.#onAssistantEvent(turn, event.assistantMessageEvent);
        break;
      case 'message_end':
        this.#onMessageEnd(turn, event.message);
        break;
      case 'tool_execution_start':
        if (event.parentToolCallId === undefined) {
          this.#onToolStart(turn, event.toolCallId, event.toolName, event.args);
        }
        break;
      case 'tool_execution_update':
        if (event.parentToolCallId === undefined) {
          this.#onToolUpdate(turn, event.toolCallId, event.partialResult);
        }
        break;
      case 'tool_execution_end':
        if (event.parentToolCallId === undefined) {
          this.#onToolEnd(turn, event.toolCallId, event.result, event.isError);
        }
        break;
      case 'compaction_start':
        this.#onCompactionStart(turn, event.reason);
        break;
      case 'compaction_end':
        this.#onCompactionEnd(turn, event);
        break;
      case 'auto_retry_start':
        this.#startTurn(turn);
        this.#sink.event('turn/retrying', {
          turnId: turn.turnId,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage.toWellFormed(),
        });
        break;
      case 'agent_settled':
        this.#settle(turn, event.aborted);
        break;
      default:
        break;
    }
  }

  #startTurn(turn: Turn): void {
    if (!turn.started) {
      turn.started = true;
      this.#sink.event('turn/started', { turnId: turn.turnId });
    }
  }

  #onMessageStart(turn: Turn, message: unknown): void {
    if (!isObject(message)) {
      return;
    }
    if (message.role === 'assistant') {
      turn.messageId = randomUUID();
      return;
    }
    if (message.role === 'user') {
      this.#startTurn(turn);
      turn.userMessages += 1;
      const item = userMessage(
        `${turn.turnId}:user:${String(turn.userMessages)}`,
        contentText(message.content) ?? '',
      );
      this.#itemEvent(turn, 'item/started', item);
      this.#itemEvent(turn, 'item/completed', item);
    }
  }

  #onMessageEnd(turn: Turn, message: unknown): void {
    if (!isObject(message) || message.role !== 'assistant') {
      return;
    }
    const stopReason = typeof message.stopReason === 'string' ? message.stopReason : undefined;
    turn.lastStopReason = stopReason;
    turn.lastErrorMessage =
      typeof message.errorMessage === 'string' ? message.errorMessage : undefined;
    turn.usage = addUsage(turn.usage, message.usage);
    this.#closeStreams(turn, statusForStop(stopReason));
    // Only a complete tool-use response makes calls; an aborted or failed one never runs them
    // (Pi drops it from the model's context).
    turn.calls =
      stopReason === 'toolUse' && Array.isArray(message.content)
        ? message.content.flatMap((part: unknown) =>
            isObject(part) &&
            part.type === 'toolCall' &&
            typeof part.id === 'string' &&
            typeof part.name === 'string'
              ? [
                  {
                    id: part.id,
                    name: part.name,
                    args: isObject(part.arguments) ? part.arguments : {},
                  },
                ]
              : [],
          )
        : [];
  }

  #onAssistantEvent(
    turn: Turn,
    event: Extract<AgentSessionEvent, { type: 'message_update' }>['assistantMessageEvent'],
  ): void {
    switch (event.type) {
      case 'text_start':
        this.#openStream(turn, 'text', event.contentIndex);
        break;
      case 'thinking_start':
        this.#openStream(turn, 'reasoning', event.contentIndex);
        break;
      case 'text_delta':
      case 'thinking_delta': {
        const open = turn.streams.get(event.contentIndex);
        if (open !== undefined) {
          this.#sendDelta(turn, open, event.delta);
        }
        break;
      }
      case 'text_end':
      case 'thinking_end': {
        const open = turn.streams.get(event.contentIndex);
        if (open !== undefined) {
          turn.streams.delete(event.contentIndex);
          this.#itemEvent(turn, 'item/completed', streamItem(open, 'completed', event.content));
        }
        break;
      }
      default:
        break;
    }
  }

  #openStream(turn: Turn, kind: StreamKind, contentIndex: number): void {
    const messageId = turn.messageId ?? randomUUID();
    turn.messageId = messageId;
    const open: OpenStream = {
      kind,
      itemId: `${messageId}#${String(contentIndex)}`,
      text: '',
      pendingHigh: '',
    };
    turn.streams.set(contentIndex, open);
    this.#itemEvent(turn, 'item/started', streamItem(open, 'inProgress', ''));
  }

  #sendDelta(turn: Turn, open: OpenStream, delta: string): void {
    let text = open.pendingHigh + delta;
    open.pendingHigh = '';
    if (text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1))) {
      open.pendingHigh = text.slice(-1);
      text = text.slice(0, -1);
    }
    if (text.length === 0) {
      return;
    }
    const wellFormed = text.toWellFormed();
    open.text += wellFormed;
    this.#sink.delta(
      open.kind === 'text' ? 'item/agentMessage/delta' : 'item/reasoning/delta',
      open.itemId,
      { turnId: turn.turnId, itemId: open.itemId },
      wellFormed,
    );
  }

  /** Completes text and reasoning items that never got their end event. */
  #closeStreams(turn: Turn, status: ItemStatus): void {
    for (const open of turn.streams.values()) {
      this.#itemEvent(
        turn,
        'item/completed',
        streamItem(open, status, open.text + open.pendingHigh),
      );
    }
    turn.streams.clear();
  }

  #onToolStart(turn: Turn, toolCallId: string, name: string, args: unknown): void {
    this.#startTurn(turn);
    const open: OpenTool = { tool: this.#toCanonical(name), arguments: isObject(args) ? args : {} };
    turn.tools.set(toolCallId, open);
    this.#itemEvent(
      turn,
      'item/started',
      toolItem(toolCallId, 'inProgress', open.tool, open.arguments, undefined),
    );
  }

  #onToolUpdate(turn: Turn, toolCallId: string, partialResult: unknown): void {
    const open = turn.tools.get(toolCallId);
    if (open === undefined) {
      return;
    }
    const item = toolItem(
      toolCallId,
      'inProgress',
      open.tool,
      open.arguments,
      resultText(partialResult),
    );
    this.#sink.replaceable('item/updated', toolCallId, { turnId: turn.turnId, item });
  }

  #onToolEnd(turn: Turn, toolCallId: string, result: unknown, isError: boolean): void {
    const open = turn.tools.get(toolCallId);
    if (open === undefined) {
      return;
    }
    turn.tools.delete(toolCallId);
    turn.finished.add(toolCallId);
    let status: ItemStatus = isError ? 'failed' : 'completed';
    if (this.#declined.delete(toolCallId)) {
      status = 'declined';
    } else if (isError && turn.aborting) {
      status = 'interrupted';
    }
    this.#itemEvent(
      turn,
      'item/completed',
      toolItem(toolCallId, status, open.tool, open.arguments, resultText(result)),
    );
  }

  #onCompactionStart(turn: Turn, reason: 'manual' | 'threshold' | 'overflow'): void {
    this.#startTurn(turn);
    turn.compactions += 1;
    const itemId = `${turn.turnId}:compaction:${String(turn.compactions)}`;
    turn.openCompaction = itemId;
    this.#itemEvent(turn, 'item/started', contextCompaction(itemId, 'inProgress', { reason }));
  }

  #onCompactionEnd(
    turn: Turn,
    event: Extract<AgentSessionEvent, { type: 'compaction_end' }>,
  ): void {
    const itemId = turn.openCompaction;
    if (itemId === undefined) {
      return;
    }
    turn.openCompaction = undefined;
    const { result } = event;
    let status: ItemStatus = 'completed';
    if (event.aborted) {
      status = 'interrupted';
    } else if (result === undefined) {
      status = 'failed';
    }
    this.#itemEvent(
      turn,
      'item/completed',
      contextCompaction(itemId, status, {
        reason: event.reason,
        ...(result === undefined ? {} : { tokensBefore: result.tokensBefore }),
        ...(result?.estimatedTokensAfter === undefined
          ? {}
          : { tokensAfter: result.estimatedTokensAfter }),
        ...(status === 'failed'
          ? { errorMessage: event.errorMessage ?? 'the compaction produced no summary' }
          : {}),
      }),
    );
  }

  #onEntry(entry: unknown): void {
    if (
      !isObject(entry) ||
      entry.type !== 'custom' ||
      typeof entry.customType !== 'string' ||
      !entry.customType.startsWith(HARNESS_ENTRY_PREFIX) ||
      typeof entry.id !== 'string'
    ) {
      return;
    }
    this.#sink.event('harness/entry', {
      entryId: entry.id,
      customType: entry.customType.toWellFormed(),
      ...(entry.data === undefined ? {} : { data: entry.data }),
    });
  }

  #settle(turn: Turn, aborted: boolean): void {
    this.#startTurn(turn);
    this.#closeOpenItems(turn, aborted ? 'interrupted' : 'completed');
    if (aborted) {
      this.#completeTurn(turn, 'interrupted');
    } else if (turn.lastStopReason === 'error') {
      this.#completeTurn(turn, 'failed', turn.lastErrorMessage ?? 'the model request failed');
    } else {
      this.#completeTurn(turn, 'completed');
    }
  }

  /** Completes every item still open: streams with `streamStatus`, tool calls (running ones and
   * the ones Pi never started) and compactions as interrupted. */
  #closeOpenItems(turn: Turn, streamStatus: ItemStatus): void {
    this.#closeStreams(turn, streamStatus);
    for (const [toolCallId, open] of turn.tools) {
      turn.finished.add(toolCallId);
      this.#itemEvent(
        turn,
        'item/completed',
        toolItem(toolCallId, 'interrupted', open.tool, open.arguments, undefined),
      );
    }
    turn.tools.clear();
    if (streamStatus === 'interrupted') {
      for (const call of turn.calls) {
        if (!turn.finished.has(call.id)) {
          turn.finished.add(call.id);
          const tool = this.#toCanonical(call.name);
          this.#itemEvent(
            turn,
            'item/started',
            toolItem(call.id, 'inProgress', tool, call.args, undefined),
          );
          this.#itemEvent(
            turn,
            'item/completed',
            toolItem(call.id, 'interrupted', tool, call.args, undefined),
          );
        }
      }
    }
    if (turn.openCompaction !== undefined) {
      this.#itemEvent(
        turn,
        'item/completed',
        contextCompaction(turn.openCompaction, 'interrupted', {}),
      );
      turn.openCompaction = undefined;
    }
  }

  #completeTurn(turn: Turn, status: TurnStatus, errorMessage?: string): void {
    this.#turn = undefined;
    this.#sink.event('turn/completed', {
      turnId: turn.turnId,
      status,
      ...(errorMessage === undefined ? {} : { errorMessage: errorMessage.toWellFormed() }),
      usage: turn.usage,
    });
  }

  #itemEvent(turn: Turn, method: 'item/started' | 'item/completed', item: Item): void {
    this.#sink.event(method, { turnId: turn.turnId, item });
  }
}

function streamItem(open: OpenStream, status: ItemStatus, text: string): Item {
  const wellFormed = text.toWellFormed();
  return open.kind === 'text'
    ? agentMessage(open.itemId, status, wellFormed)
    : reasoning(open.itemId, status, wellFormed);
}

function statusForStop(stopReason: string | undefined): ItemStatus {
  if (stopReason === 'aborted') {
    return 'interrupted';
  }
  return stopReason === 'error' ? 'failed' : 'completed';
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
