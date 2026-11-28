// Harness Kit: the transcript after an interrupted turn (architecture sections 6.1.2 and 6.15,
// issue I18). Pi 1.5.2 leaves two gaps that this module closes when a turn settles aborted:
//
// 1. Tool calls the abort cut off before Pi created their result (calls not prepared yet when
//    the abort came) have no tool result in the session file. pi-ai papers over that per request
//    with an error result "No result provided"; here every such call gets a persisted result
//    saying it was interrupted, so the tool_use / tool_result pairing is complete in the file
//    and in every request.
// 2. Pi drops an aborted (or failed) response from the model's context, so the next user input
//    would follow the previous user message or tool results directly: two user turns in a row.
//    A short assistant message (the interruption marker) closes the interrupted turn instead.
//
// The marker carries the session's current provider and model (Pi derives a resumed session's
// model from the last assistant message) and `rawStopReason` `piarc-interrupted`, a field Pi
// keeps for debugging only; the history projection leaves the marker out.
import type { AgentSession, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';

/**
 * pi-ai 1.5.2 closes pending tool calls before filtering an aborted/errored assistant
 * message (api/transform-messages.js). During preflight cancellation that message can sit
 * between a real result and the results appended by repairInterruptedTurn. Filter the
 * discarded response before provider conversion so each call reaches the model once.
 */
export const interruptedContext: ExtensionFactory = (pi) => {
  pi.on('context', ({ messages }) => {
    const visible = messages.filter(
      (m) => m.role !== 'assistant' || (m.stopReason !== 'aborted' && m.stopReason !== 'error'),
    );
    if (visible.length !== messages.length) return { messages: visible };
    return undefined;
  });
};

/** What a tool call the interruption cut off returns to the model. */
export const INTERRUPTED_TOOL_RESULT = 'Interrupted by the user before this tool call finished.';

/** The text of the marker that closes an interrupted turn. */
export const INTERRUPTION_MARKER_TEXT = '[The user interrupted this turn.]';

/** `rawStopReason` of the marker. */
export const INTERRUPTION_MARKER_REASON = 'piarc-interrupted';

/** What the repair appended. */
export interface InterruptionRepair {
  /** Interrupted results added for tool calls without one. */
  readonly toolResults: number;
  /** Whether the marker was added. */
  readonly marker: boolean;
}

/** Whether `message` is the marker this module appends. */
export function isInterruptionMarker(message: { readonly rawStopReason?: string }): boolean {
  return message.rawStopReason === INTERRUPTION_MARKER_REASON;
}

/** What the repair needs from Pi's session. */
export type RepairableSession = Pick<AgentSession, 'sessionManager' | 'model' | 'refreshContext'>;

type ContextMessage = ReturnType<
  AgentSession['sessionManager']['buildSessionProjection']
>['messages'][number];

/** Whether the model sees `message` as a response (Pi drops aborted and failed ones). */
function isResponse(message: ContextMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.stopReason !== 'aborted' &&
    message.stopReason !== 'error'
  );
}

/**
 * Closes the session's interrupted turn: interrupted results for the cut-off tool calls of the
 * last response, then the marker if the model-visible conversation does not end with a
 * response. Persists both to the session file and refreshes the agent's context. Call it when
 * the turn settled aborted, before the next input.
 */
export function repairInterruptedTurn(
  session: RepairableSession,
  expired: ReadonlyMap<string, string> = new Map(),
): InterruptionRepair {
  const manager = session.sessionManager;
  const missing = missingToolCalls(session);
  const toolResults = missing.length;
  for (const call of missing) {
    const reason = expired.get(call.id);
    const result: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: reason ?? INTERRUPTED_TOOL_RESULT }],
      isError: true,
      timestamp: Date.now(),
      ...(reason === undefined ? {} : { details: { approvalExpired: true } }),
    };
    manager.appendMessage(result);
  }
  // Summaries and reminders are context, not input awaiting an answer: a conversation that ends
  // with a branch summary (T28's "summarize from here") or a reminder after a response is not an
  // interrupted turn.
  const tail = manager
    .buildSessionProjection()
    .messages.findLast(
      (message) =>
        message.role === 'user' ||
        message.role === 'toolResult' ||
        (message.role === 'assistant' && isResponse(message)),
    );
  const { model } = session;
  const marker = tail !== undefined && tail.role !== 'assistant' && model !== undefined;
  if (marker) {
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: INTERRUPTION_MARKER_TEXT }],
      api: typeof model.api === 'string' ? model.api : 'unknown',
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      rawStopReason: INTERRUPTION_MARKER_REASON,
      timestamp: Date.now(),
    };
    manager.appendMessage(message);
  }
  if (toolResults > 0 || marker) {
    session.refreshContext();
  }
  return { toolResults, marker };
}

/** Only the last model-visible response can have calls to complete during recovery. */
export function missingToolCalls(session: RepairableSession): { id: string; name: string }[] {
  const messages = session.sessionManager.buildSessionProjection().messages;
  const lastResponse = messages.findLastIndex(isResponse);
  const response = messages[lastResponse];
  if (response?.role !== 'assistant') return [];
  const answered = new Set(
    messages
      .slice(lastResponse + 1)
      .flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : [])),
  );
  return response.content.flatMap((part) =>
    part.type === 'toolCall' && !answered.has(part.id) ? [{ id: part.id, name: part.name }] : [],
  );
}
