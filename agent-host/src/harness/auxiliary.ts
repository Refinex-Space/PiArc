// The auxiliary model channel (T29): one tool-free model call for work the session's model
// should not spend its context on, such as WebFetch's extraction (and M5's Auto mode review).
//
// - Model: the "auxiliary model" setting (Core's model preferences) when it is configured and
//   has credentials, otherwise the session's model; a caller may name the model (T38: a native
//   search goes to the session's provider, a prompt hook's `model`).
// - The request carries no tools, no conversation and no prompt caching; it is retried per the
//   session's retry settings and goes through the session's stream function, so credentials,
//   the provider policy and error redaction are those of every other request.
// - Usage: reported to `onUsage`, which counts it toward the session's running turn and records
//   it on the branch (`piarc.auxiliaryUsage`).
import { randomUUID } from 'node:crypto';

import type { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  contentText,
  normalizeContext,
  retryAssistantCall,
  type Api,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import type { ModelRef } from '@piarc/protocol';

import type { ModelPreferencesStore } from '../providers/preferences.js';

/** Branch entry recording one auxiliary call's usage. */
export const AUXILIARY_USAGE_ENTRY = 'piarc.auxiliaryUsage';

export interface AuxiliaryRequest {
  /** What the call is for, recorded with its usage (`webFetch`, `webSearch`, `hookPrompt`). */
  readonly purpose: string;
  readonly system: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  /** The model to ask instead of the auxiliary model. */
  readonly model?: Model<Api>;
  /** Changes the provider request (a native search adds the provider's search tool). */
  readonly onPayload?: (payload: unknown) => unknown;
  /** Sees every raw provider stream event (a native search reads its result blocks). */
  readonly onProviderStreamEvent?: (event: unknown) => void;
}

export interface AuxiliaryResult {
  readonly text: string;
  readonly usage: Usage;
  readonly model: ModelRef;
}

export interface AuxiliaryOptions {
  readonly runtime: ModelRuntime;
  readonly preferences: ModelPreferencesStore;
  readonly session: () => AgentSession | undefined;
  /** A call finished with `usage` on `model`. */
  readonly onUsage: (usage: Usage, model: ModelRef, purpose: string) => void;
  readonly log: (line: string) => void;
}

/** One session's auxiliary calls. */
export class AuxiliaryModel {
  readonly #o: AuxiliaryOptions;

  constructor(options: AuxiliaryOptions) {
    this.#o = options;
  }

  /** The model a call uses now. */
  model(): Model<Api> {
    const chosen = this.#o.preferences.auxiliary;
    if (chosen !== undefined) {
      const model = this.#o.runtime.getModel(chosen.provider, chosen.id);
      if (model !== undefined && this.#o.runtime.hasConfiguredAuth(model.provider)) return model;
      this.#o.log(
        `auxiliary model ${chosen.provider}/${chosen.id} is unavailable; using the session's model`,
      );
    }
    const model: Model<Api> | undefined = this.#o.session()?.model;
    if (model === undefined) throw new Error('No model is selected');
    return model;
  }

  async complete(request: AuxiliaryRequest): Promise<AuxiliaryResult> {
    const session = this.#o.session();
    if (session === undefined) throw new Error('The session is not open');
    const model = request.model ?? this.model();
    const context = normalizeContext({
      systemPrompt: request.system,
      messages: [
        { role: 'user', content: [{ type: 'text', text: request.prompt }], timestamp: Date.now() },
      ],
    });
    const { onPayload, onProviderStreamEvent } = request;
    const options = {
      signal: request.signal,
      cacheRetention: 'none' as const,
      sessionId: randomUUID(),
      ...(onPayload === undefined ? {} : { onPayload: (payload: unknown) => onPayload(payload) }),
      ...(onProviderStreamEvent === undefined
        ? {}
        : {
            onProviderStreamEvent: (event: unknown) => {
              onProviderStreamEvent(event);
            },
          }),
    };
    const stream = session.agent.streamFunction;
    const response = await retryAssistantCall(
      async () => (await stream(model, context, options)).result(),
      session.settingsManager.getRetrySettings(),
      request.signal,
    );
    const ref = { provider: model.provider, id: model.id };
    this.#o.onUsage(response.usage, ref, request.purpose);
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new Error(response.errorMessage ?? 'the auxiliary model request failed');
    }
    return { text: contentText(response.content).trim(), usage: response.usage, model: ref };
  }
}
