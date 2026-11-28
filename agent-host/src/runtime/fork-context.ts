// A conversation fork snapshots the active branch before the child starts. Pi's transform
// has already resolved the parent's prompt and visible tools for its most recent request.
import { getCurrentSystemMessage, type Message, type SystemMessage } from '@earendil-works/pi-ai';
import {
  buildSessionContext,
  convertToLlm,
  type AgentSession,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';

interface SentContext {
  readonly leaf: string | null;
  readonly declarations: SystemMessage[];
}

export interface ForkContext {
  readonly leaf: string | null;
  readonly messages: readonly Message[];
  readonly system: SystemMessage | undefined;
  readonly memory: unknown;
}

const sent = new WeakMap<AgentSession, SentContext>();

/** A fork uses its parent's last declarations while the local agent executes through its
 * own tool gate. A registered tool that the child cannot call stays blocked. */
export function trackForkContext(session: AgentSession, inherited?: ForkContext): void {
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) =>
    stream(
      model,
      context,
      model.api === 'anthropic-messages' && options?.sessionId === session.sessionId
        ? { ...options, disableContinuation: true }
        : options,
    );
  const transform = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const local = transform ? await transform(messages, signal) : messages;
    const effective = inherited?.system
      ? [inherited.system, ...local.filter((message) => message.role !== 'system')]
      : local;
    sent.set(session, {
      leaf: session.sessionManager.getLeafId(),
      declarations: effective.filter(
        (message): message is SystemMessage => message.role === 'system',
      ),
    });
    return effective;
  };
}

/** Take only the parent branch, including messages recorded since its last request (the
 * assistant response which launched the fork, for example). A reopened session has its
 * persistent declarations and frozen prompt, even before making another request. */
export function forkContext(session: AgentSession, completedLeaf?: string | null): ForkContext {
  const manager = session.sessionManager;
  const branch = manager.getBranch();
  const previous = sent.get(session);
  // Restore from durable entries, not provider-only transformations: in particular, the
  // server compaction extension creates temporary markers which only it knows how to replay.
  const leaf = completedLeaf === undefined ? manager.getLeafId() : completedLeaf;
  const messages = convertToLlm(buildSessionContext(branch, leaf).messages);
  const onBranch = previous?.leaf != null && branch.some((entry) => entry.id === previous.leaf);
  const memory = branch.findLast(
    (e) => e.type === 'custom' && e.customType === 'piarc.systemPrompt',
  );
  const system = getCurrentSystemMessage(previous && onBranch ? previous.declarations : messages);
  if (system && !onBranch) {
    const text =
      memory?.type === 'custom' &&
      typeof memory.data === 'object' &&
      memory.data !== null &&
      'system' in memory.data
        ? memory.data.system
        : undefined;
    if (typeof text === 'string') {
      system.content = text;
      delete system.sections;
    }
  }
  return {
    leaf,
    messages,
    system,
    memory: memory?.type === 'custom' ? memory.data : undefined,
  };
}

/** Own JSONL, independent compaction. Inherited messages do not represent new turns or
 * billable requests; the Core index recognizes the marker when rebuilding or tailing. */
export function seedFork(manager: SessionManager, context: ForkContext): void {
  if (context.memory !== undefined) manager.appendCustomEntry('piarc.systemPrompt', context.memory);
  if (context.system) manager.appendMessage(context.system);
  for (const message of context.messages) {
    if (message.role !== 'system') {
      const inherited = { ...message, piarcInherited: true };
      manager.appendMessage(inherited);
    }
  }
  const lastAssistant = context.messages.findLastIndex((message) => message.role === 'assistant');
  const assistant = context.messages[lastAssistant];
  if (assistant?.role !== 'assistant') return;
  const answered = new Set(
    context.messages
      .slice(lastAssistant + 1)
      .flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : [])),
  );
  for (const call of assistant.content) {
    if (call.type === 'toolCall' && !answered.has(call.id)) {
      manager.appendMessage({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        timestamp: Date.now(),
        isError: false,
        content: [{ type: 'text', text: 'This call is still running in the parent conversation.' }],
      });
    }
  }
}
