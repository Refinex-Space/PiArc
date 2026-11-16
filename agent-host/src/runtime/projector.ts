// Minimal projection of Pi session events onto AHP `turn/*` and `item/*` notifications
// (architecture section 5.3). T14 completes it; this version covers:
//
// - the first `agent_start` of a prompt → `turn/started`;
// - assistant text: `text_start` → `item/started`, `text_delta` → `item/agentMessage/delta`,
//   `text_end` → `item/completed`, with itemId `<messageId>#<contentIndex>`;
// - tool execution start and end → `item/started` / `item/completed` (`dynamicToolCall`), with
//   the canonical tool name;
// - `agent_settled` → `turn/completed`.
//
// `messageId` is generated here when an assistant message starts streaming: Pi assigns the
// session entry id only when the message is persisted, after the deltas went out.
//
// Strings sent to Core must be well-formed UTF-16 (the Rust side rejects lone surrogates,
// PLAN.md I08). A model's text delta can end between the two halves of a surrogate pair; the
// high half is held back and sent with the next delta. Any surrogate still unpaired becomes
// U+FFFD.
import { randomUUID } from 'node:crypto';

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Item, ItemStatus, TurnStatus } from '@piarc/protocol';

import { wellFormedJson } from '../protocol/well-formed.js';

/** Where projected notifications go (the outbound queue, bound to one session). */
export interface ProjectionSink {
  event(method: string, payload: Record<string, unknown>): void;
  delta(method: string, mergeKey: string, payload: Record<string, unknown>, delta: string): void;
}

interface OpenText {
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
  messageId: string | undefined;
  readonly texts: Map<number, OpenText>;
  readonly tools: Map<string, OpenTool>;
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
}

export class Projector {
  readonly #sink: ProjectionSink;
  readonly #toCanonical: (tool: string) => string;
  #turn: Turn | undefined;

  /** `toCanonical` maps the model-visible tool names of the session's Tool Profile to canonical
   * names: Core sees canonical names only (architecture section 6.1.1). */
  constructor(sink: ProjectionSink, toCanonical: (tool: string) => string = (tool) => tool) {
    this.#sink = sink;
    this.#toCanonical = toCanonical;
  }

  /** The turn accepted for the current prompt, until it completes. */
  get activeTurnId(): string | undefined {
    return this.#turn?.turnId;
  }

  /** Accepts a prompt: its events will belong to `turnId`. */
  beginTurn(turnId: string): void {
    this.#turn = {
      turnId,
      started: false,
      messageId: undefined,
      texts: new Map(),
      tools: new Map(),
      lastStopReason: undefined,
      lastErrorMessage: undefined,
    };
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
    this.#completeTurn(turn, status, errorMessage);
  }

  /** Projects one Pi session event. Events outside an accepted turn are ignored. */
  handle(event: AgentSessionEvent): void {
    const turn = this.#turn;
    if (turn === undefined) {
      return;
    }
    switch (event.type) {
      case 'agent_start':
        this.#startTurn(turn);
        break;
      case 'message_start':
        if (event.message.role === 'assistant') {
          turn.messageId = randomUUID();
        }
        break;
      case 'message_update':
        this.#onAssistantEvent(turn, event.assistantMessageEvent);
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          turn.lastStopReason = event.message.stopReason;
          turn.lastErrorMessage = event.message.errorMessage;
          this.#closeTexts(turn, statusForStop(event.message.stopReason));
        }
        break;
      case 'tool_execution_start':
        this.#onToolStart(turn, event.toolCallId, this.#toCanonical(event.toolName), event.args);
        break;
      case 'tool_execution_end':
        this.#onToolEnd(turn, event.toolCallId, event.result, event.isError);
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

  #onAssistantEvent(
    turn: Turn,
    event: Extract<AgentSessionEvent, { type: 'message_update' }>['assistantMessageEvent'],
  ): void {
    switch (event.type) {
      case 'text_start': {
        const messageId = turn.messageId ?? randomUUID();
        turn.messageId = messageId;
        const open: OpenText = {
          itemId: `${messageId}#${String(event.contentIndex)}`,
          text: '',
          pendingHigh: '',
        };
        turn.texts.set(event.contentIndex, open);
        this.#itemEvent(turn, 'item/started', agentMessage(open.itemId, 'inProgress', ''));
        break;
      }
      case 'text_delta': {
        const open = turn.texts.get(event.contentIndex);
        if (open !== undefined) {
          this.#sendDelta(turn, open, event.delta);
        }
        break;
      }
      case 'text_end': {
        const open = turn.texts.get(event.contentIndex);
        if (open !== undefined) {
          turn.texts.delete(event.contentIndex);
          this.#itemEvent(
            turn,
            'item/completed',
            agentMessage(open.itemId, 'completed', event.content.toWellFormed()),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  #sendDelta(turn: Turn, open: OpenText, delta: string): void {
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
      'item/agentMessage/delta',
      open.itemId,
      { turnId: turn.turnId, itemId: open.itemId },
      wellFormed,
    );
  }

  /** Completes text items that never got `text_end` (the message was aborted or failed). */
  #closeTexts(turn: Turn, status: ItemStatus): void {
    for (const open of turn.texts.values()) {
      const text = (open.text + open.pendingHigh).toWellFormed();
      this.#itemEvent(turn, 'item/completed', agentMessage(open.itemId, status, text));
    }
    turn.texts.clear();
  }

  #onToolStart(turn: Turn, toolCallId: string, tool: string, args: unknown): void {
    const open: OpenTool = { tool, arguments: isObject(args) ? args : {} };
    turn.tools.set(toolCallId, open);
    this.#itemEvent(turn, 'item/started', toolCall(toolCallId, 'inProgress', open, undefined));
  }

  #onToolEnd(turn: Turn, toolCallId: string, result: unknown, isError: boolean): void {
    const open = turn.tools.get(toolCallId);
    if (open === undefined) {
      return;
    }
    turn.tools.delete(toolCallId);
    const status: ItemStatus = isError ? 'failed' : 'completed';
    this.#itemEvent(turn, 'item/completed', toolCall(toolCallId, status, open, resultText(result)));
  }

  #settle(turn: Turn, aborted: boolean): void {
    this.#closeTexts(turn, aborted ? 'interrupted' : 'completed');
    for (const [toolCallId, open] of turn.tools) {
      this.#itemEvent(turn, 'item/completed', toolCall(toolCallId, 'interrupted', open, undefined));
    }
    turn.tools.clear();
    this.#startTurn(turn);
    if (aborted) {
      this.#completeTurn(turn, 'interrupted');
    } else if (turn.lastStopReason === 'error') {
      this.#completeTurn(turn, 'failed', turn.lastErrorMessage ?? 'the model request failed');
    } else {
      this.#completeTurn(turn, 'completed');
    }
  }

  #completeTurn(turn: Turn, status: TurnStatus, errorMessage?: string): void {
    this.#turn = undefined;
    this.#sink.event('turn/completed', {
      turnId: turn.turnId,
      status,
      ...(errorMessage === undefined ? {} : { errorMessage: errorMessage.toWellFormed() }),
    });
  }

  #itemEvent(turn: Turn, method: 'item/started' | 'item/completed', item: Item): void {
    this.#sink.event(method, { turnId: turn.turnId, item });
  }
}

function agentMessage(itemId: string, status: ItemStatus, text: string): Item {
  return { type: 'agentMessage', itemId, status, text };
}

function toolCall(
  itemId: string,
  status: ItemStatus,
  open: OpenTool,
  output: string | undefined,
): Item {
  return {
    type: 'dynamicToolCall',
    itemId,
    status,
    tool: open.tool,
    // Tool arguments come from the model.
    arguments: wellFormedJson(open.arguments),
    ...(output === undefined ? {} : { output }),
  };
}

function statusForStop(stopReason: string): ItemStatus {
  if (stopReason === 'aborted') {
    return 'interrupted';
  }
  return stopReason === 'error' ? 'failed' : 'completed';
}

/** The text parts of a tool result (`AgentToolResult.content`), joined. */
function resultText(result: unknown): string | undefined {
  if (!isObject(result) || !Array.isArray(result.content)) {
    return undefined;
  }
  const parts = result.content.flatMap((part: unknown) =>
    isObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  );
  return parts.join('\n').toWellFormed();
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
