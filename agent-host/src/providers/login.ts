// Provider sign-in (architecture section 5.4, T29). Core runs it on the settings Host:
// `models/login/start` calls Pi's `ModelRuntime.login(provider, "oauth", interaction)`; the
// interaction's prompts and events (authorization URL, device code, progress, questions) go to
// the client as `ui/loginInteraction` requests, which Core answers with the user's input. The
// provider's flow receives the browser's redirect on its own loopback server. The credential is
// stored by `ModelRuntime.login` through the vault adapter (CoreCredentialStore): never on disk
// here. Anthropic's subscription sign-in stays refused by providers/policy.ts (ADR-0006).
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { LoginInteraction, LoginProvider } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';

/** The providers the settings window offers sign-in for. Anthropic's OAuth method was removed
 * from its provider before this runs, so it never appears. */
export async function loginProviders(runtime: ModelRuntime): Promise<LoginProvider[]> {
  const signedIn = new Set(
    (await runtime.listCredentials())
      .filter((info) => info.type === 'oauth')
      .map((info) => info.providerId),
  );
  return runtime
    .getProviders()
    .flatMap((provider) => {
      const oauth = provider.auth.oauth;
      if (oauth === undefined) return [];
      return [
        {
          id: provider.id,
          name: provider.name,
          label: oauth.loginLabel ?? oauth.name,
          subscription: oauth.isSubscription === true,
          signedIn: signedIn.has(provider.id),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function promptInteraction(prompt: AuthPrompt): LoginInteraction {
  const placeholder =
    prompt.type !== 'select' && prompt.placeholder !== undefined
      ? { placeholder: prompt.placeholder }
      : {};
  switch (prompt.type) {
    case 'select':
      return {
        type: 'prompt',
        kind: 'select',
        message: prompt.message,
        options: prompt.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      };
    case 'manual_code':
      return { type: 'prompt', kind: 'manualCode', message: prompt.message, ...placeholder };
    default:
      return { type: 'prompt', kind: prompt.type, message: prompt.message, ...placeholder };
  }
}

function eventInteraction(event: AuthEvent): LoginInteraction {
  switch (event.type) {
    case 'auth_url':
      return {
        type: 'authUrl',
        url: event.url,
        ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
      };
    case 'device_code':
      return {
        type: 'deviceCode',
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: event.expiresInSeconds }),
      };
    case 'info':
      return {
        type: 'info',
        message: event.message,
        links: (event.links ?? []).map((link) => ({
          url: link.url,
          ...(link.label === undefined ? {} : { label: link.label }),
        })),
      };
    case 'progress':
      return { type: 'progress', message: event.message };
  }
}

function parseAnswer(value: unknown): { value?: string } | undefined {
  if (!isObject(value)) return undefined;
  if (value.value == null) return {};
  return typeof value.value === 'string' ? { value: value.value } : undefined;
}

/** The sign-ins running on this Host, by Core's login id. */
export class Logins {
  readonly #active = new Map<string, AbortController>();
  readonly #runtime: ModelRuntime;
  readonly #bridge: CoreBridge;
  readonly #log: (line: string) => void;

  constructor(runtime: ModelRuntime, bridge: CoreBridge, log: (line: string) => void) {
    this.#runtime = runtime;
    this.#bridge = bridge;
    this.#log = log;
  }

  /** Signs in to `provider`; resolves once the credential is stored. */
  async start(loginId: string, provider: string): Promise<Record<string, never>> {
    if (this.#active.has(loginId)) {
      throw new AhpError('invalidParams', `sign-in ${loginId} is already running`);
    }
    if (this.#runtime.getProvider(provider)?.auth.oauth === undefined) {
      throw new AhpError('invalidParams', `${provider} has no sign-in`, {
        details: { member: 'provider' },
      });
    }
    const controller = new AbortController();
    this.#active.set(loginId, controller);
    const send = (interaction: LoginInteraction, signal: AbortSignal) =>
      this.#bridge.requestTyped(
        'ui/loginInteraction',
        { loginId, provider, interaction },
        parseAnswer,
        // The user takes as long as they take; the sign-in's own timeout or a cancel ends it.
        { signal, timeoutMs: null },
      );
    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: async (prompt) => {
        const signal =
          prompt.signal === undefined
            ? controller.signal
            : AbortSignal.any([controller.signal, prompt.signal]);
        const answer = await send(promptInteraction(prompt), signal);
        if (answer.value === undefined) throw new Error('The sign-in was cancelled');
        return answer.value;
      },
      notify: (event) => {
        send(eventInteraction(event), controller.signal).catch((error: unknown) => {
          if (!controller.signal.aborted) {
            this.#log(`ui/loginInteraction failed: ${String(error)}`);
          }
        });
      },
    };
    try {
      await this.#runtime.login(provider, 'oauth', interaction, { agentName: 'PiArc' });
      this.#log(`signed in to ${provider}`);
      return {};
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AhpError('cancelled', 'The sign-in was cancelled');
      }
      throw error instanceof AhpError
        ? error
        : new AhpError('permissionDenied', error instanceof Error ? error.message : String(error));
    } finally {
      this.#active.delete(loginId);
    }
  }

  /** Stops a running sign-in; unknown ids are ignored (it already ended). */
  cancel(loginId: string): Record<string, never> {
    this.#active.get(loginId)?.abort();
    return {};
  }

  /** Removes the provider's stored credential. */
  async logout(provider: string): Promise<Record<string, never>> {
    await this.#runtime.logout(provider);
    return {};
  }
}
