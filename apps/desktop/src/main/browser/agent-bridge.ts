// Core ↔ script hosts (ADR-0089, design addendum B2.1.2). The main process tells Core at start
// that it runs `Browser` scripts (`attachBrowserClient`), then follows the `core/browser`
// route: a `run` event starts a script host for the call, its answer goes back through
// `answerBrowserRun`; a `cancel` event (interrupt, session closed, Core's timeout) ends the
// host. The events come from Core; the bridge still checks their shape.

import type { BrowserRunAnswer } from '@piarc/protocol';

import type { EventBatch } from '../../shared/ipc.js';
import type { AgentRun } from './script-host.js';

export const BROWSER_ROUTE = 'core/browser';

/** What the bridge uses of Core. */
export interface BridgeCore {
  attachBrowserClient(): void;
  answerBrowserRun(runId: string, answerJson: string): boolean;
}

/** What the bridge uses of the script hosts. */
export interface BridgeHosts {
  run(run: AgentRun): Promise<BrowserRunAnswer | undefined>;
  cancel(runId: string): void;
}

type ClientEvent =
  | { readonly type: 'run'; readonly run: AgentRun }
  | {
      readonly type: 'cancel';
      readonly runId: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One `core/browser` event, or undefined when it is not one. */
export function parseClientEvent(value: unknown): ClientEvent | undefined {
  if (!isRecord(value) || typeof value.runId !== 'string') return undefined;
  if (value.type === 'cancel') return { type: 'cancel', runId: value.runId };
  if (
    value.type !== 'run' ||
    typeof value.mainSessionId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.toolCallId !== 'string' ||
    typeof value.script !== 'string' ||
    typeof value.timeoutMs !== 'number' ||
    !Number.isFinite(value.timeoutMs) ||
    value.timeoutMs <= 0
  ) {
    return undefined;
  }
  return {
    type: 'run',
    run: {
      runId: value.runId,
      sessionId: value.mainSessionId,
      ...(typeof value.workspace === 'string' && value.workspace !== ''
        ? { workspace: value.workspace }
        : {}),
      callSessionId: value.sessionId,
      toolCallId: value.toolCallId,
      ...(typeof value.agentType === 'string' ? { agentType: value.agentType } : {}),
      script: value.script,
      timeoutMs: value.timeoutMs,
    },
  };
}

export class AgentBridge {
  readonly #decoder = new TextDecoder();

  constructor(
    private readonly core: BridgeCore,
    private readonly hosts: BridgeHosts,
  ) {}

  /** Tells Core the desktop client runs `Browser` scripts. */
  attach(): void {
    this.core.attachBrowserClient();
  }

  /** A batch of the `core/browser` route. */
  deliver(batch: EventBatch): void {
    let events: unknown;
    try {
      events = JSON.parse(this.#decoder.decode(batch.payload));
    } catch {
      console.warn('[browser] a core/browser batch is not JSON');
      return;
    }
    if (!Array.isArray(events)) return;
    for (const value of events as unknown[]) {
      const event = parseClientEvent(value);
      if (event === undefined) {
        console.warn('[browser] ignored a malformed core/browser event');
      } else if (event.type === 'cancel') {
        this.hosts.cancel(event.runId);
      } else {
        void this.#run(event.run);
      }
    }
  }

  async #run(run: AgentRun): Promise<void> {
    let answer: BrowserRunAnswer | undefined;
    try {
      answer = await this.hosts.run(run);
    } catch (error) {
      answer = {
        output: '',
        error: {
          name: 'Error',
          message: `The browser could not run the script: ${
            error instanceof Error ? error.message : String(error)
          }`,
          code: 'PIARC_RUN_ENDED',
        },
      };
    }
    // A cancelled run has no answer: Core already ended it.
    if (answer === undefined) return;
    try {
      this.core.answerBrowserRun(run.runId, JSON.stringify(answer));
    } catch (error) {
      console.warn('[browser] Core refused a run answer', error);
    }
  }
}
