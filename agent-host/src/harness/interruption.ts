// Harness Kit: the transcript after an interrupted turn (architecture sections 6.1.2 and 6.15,
// PLAN.md I18). Pi 1.5.2 leaves two gaps that this module closes when a turn settles aborted:
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
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';

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
export function repairInterruptedTurn(session: RepairableSession): InterruptionRepair {
  const manager = session.sessionManager;
  const messages = manager.buildSessionProjection().messages;
  let toolResults = 0;
  const lastResponse = messages.findLastIndex(isResponse);
  const response = messages[lastResponse];
  if (response?.role === 'assistant') {
    const answered = new Set(
      messages
        .slice(lastResponse + 1)
        .flatMap((message) => (message.role === 'toolResult' ? [message.toolCallId] : [])),
    );
    for (const part of response.content) {
      if (part.type === 'toolCall' && !answered.has(part.id)) {
        const result: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: part.id,
          toolName: part.name,
          content: [{ type: 'text', text: INTERRUPTED_TOOL_RESULT }],
          isError: true,
          timestamp: Date.now(),
        };
        manager.appendMessage(result);
        toolResults += 1;
      }
    }
  }
  const tail = manager
    .buildSessionProjection()
    .messages.filter((message) => message.role !== 'system')
    .findLast((message) => message.role !== 'assistant' || isResponse(message));
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
