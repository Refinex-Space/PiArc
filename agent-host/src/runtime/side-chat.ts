// Side conversations hold only memory, a snapshot of completed main turns and tool
// declarations. No executable tools, extensions, queues or session events are attached.
import {
  contentText,
  normalizeContext,
  type Api,
  type Model,
  type Tool,
  type Message,
  type SimpleStreamOptions,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { convertToLlm, SessionManager } from '@earendil-works/pi-coding-agent';
import type { SideChatAnswer, SideChatUsage } from '@piarc/protocol';
import { anthropicMemoryPayload } from '../harness/memory-wire.js';
import { AhpError } from '../protocol/errors.js';
import { forkContext } from './fork-context.js';
import type { HostedSession } from './session-types.js';

const toolRefusal = 'Side chats cannot execute tools.';
interface Panel {
  manager: SessionManager;
  active?: AbortController;
}

export class SideChats {
  readonly #panels = new Map<string, Panel>();

  async ask(parent: HostedSession, id: string, text: string): Promise<SideChatAnswer> {
    const session = parent.runtime.session;
    const model: Model<Api> | undefined = session.model;
    if (!model) throw new AhpError('invalidParams', 'No model is selected');
    let panel = this.#panels.get(id);
    if (!panel) {
      const manager = SessionManager.inMemory(session.sessionManager.getCwd());
      const activeTurn = parent.projector.activeTurnId;
      const leaf =
        activeTurn && parent.turnFrom?.turnId === activeTurn
          ? parent.turnFrom.from
          : session.sessionManager.getLeafId();
      const { messages, system: declarations } = forkContext(session, leaf);
      const tools: readonly Tool[] = session.agent.state.tools;
      manager.appendMessage(
        declarations ?? {
          role: 'system',
          content: session.systemPrompt,
          timestamp: Date.now(),
          toolsAdded: tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        },
      );
      for (const message of messages) {
        if (message.role !== 'system') manager.appendMessage(message);
      }
      panel = { manager };
      this.#panels.set(id, panel);
    }
    if (panel.active)
      throw new AhpError('sessionBusy', 'There is an answer in progress in this panel');
    const controller = new AbortController();
    panel.active = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
    const usage: SideChatUsage[] = [];
    const history = convertToLlm(panel.manager.buildSessionContext().messages);
    const additions: Message[] = [{ role: 'user', content: text, timestamp: Date.now() }];
    const options: SimpleStreamOptions = {
      sessionId: panel.manager.getSessionId(),
      signal,
      disableContinuation: true,
      onPayload: (payload) =>
        model.api === 'anthropic-messages'
          ? anthropicMemoryPayload(payload, parent.memory.frozenSystem)
          : undefined,
    };
    try {
      // A tool refusal goes back to the model once; a repeated attempt ends the answer locally.
      for (let step = 0; step < 2; step++) {
        const response = await (
          await session.agent.streamFunction(
            model,
            normalizeContext({ messages: [...history, ...additions] }),
            options,
          )
        ).result();
        const u = response.usage;
        if (
          (response.stopReason !== 'error' && response.stopReason !== 'aborted') ||
          u.totalTokens > 0
        ) {
          usage.push({
            model: { provider: response.provider, id: response.model },
            input: u.input,
            output: u.output,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
            cacheWrite1h: u.cacheWrite1h ?? 0,
            reasoning: u.reasoning ?? 0,
          });
        }
        if (controller.signal.aborted)
          return { text: contentText(response.content), stopped: true, usage };
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          return {
            text: '',
            stopped: false,
            usage,
            error: response.errorMessage ?? 'Side chat request failed',
          };
        }
        additions.push(response);
        const calls = response.content.filter((part) => part.type === 'toolCall');
        for (const call of calls) {
          const denial: ToolResultMessage = {
            role: 'toolResult',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: toolRefusal }],
            isError: true,
            timestamp: Date.now(),
          };
          additions.push(denial);
        }
        if (!calls.length || step === 1) {
          for (const message of additions) panel.manager.appendMessage(message);
          return {
            text: calls.length ? toolRefusal : contentText(response.content),
            stopped: false,
            usage,
          };
        }
      }
      throw new Error('Unreachable side chat state');
    } catch (error) {
      if (controller.signal.aborted) return { text: '', stopped: true, usage };
      return {
        text: '',
        stopped: false,
        usage,
        error: error instanceof Error ? error.message : 'Side chat request failed',
      };
    } finally {
      delete panel.active;
    }
  }

  control(id: string, close: boolean): void {
    this.#panels.get(id)?.active?.abort();
    if (close) this.#panels.delete(id);
  }

  dispose(): void {
    for (const panel of this.#panels.values()) panel.active?.abort();
    this.#panels.clear();
  }
}
