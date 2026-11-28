// Provider sign-in (architecture section 5.4, T29). Core runs it on the settings Host:
// `models/login/start` calls Pi's `ModelRuntime.login(provider, "oauth", interaction)`; the
// interaction's prompts and events (authorization URL, device code, progress, questions) go to
// the client as `ui/loginInteraction` requests, which Core answers with the user's input. The
// provider's flow receives the browser's redirect on its own loopback server. The credential is
// stored by `ModelRuntime.login` through the vault adapter (CoreCredentialStore): never on disk
// here. Anthropic's subscription sign-in stays refused by providers/policy.ts (ADR-0006).
//
// Some flows identify the installation (Sign in with ChatGPT sends it as its agent host ID): the
// ID is a random UUID made on first use and kept in `<data dir>/agent-host/installation-id`.
// It is an identifier, not a secret, like the `deviceId` Pi's own CLI keeps in its settings.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  CredentialStore,
} from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { LoginInteraction, LoginProvider, LoginStartResult } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import { accountName, githubLogin } from './accounts.js';

/** The providers the settings window offers sign-in for. Anthropic's OAuth method was removed
 * from its provider before this runs, so it never appears. */
export async function loginProviders(
  runtime: ModelRuntime,
  credentials?: CredentialStore,
): Promise<LoginProvider[]> {
  const signedIn = new Set(
    (await runtime.listCredentials())
      .filter((info) => info.type === 'oauth')
      .map((info) => info.providerId),
  );
  const listed = runtime
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
  // Who is signed in, as far as the stored credential tells (ADR-0083).
  return Promise.all(
    listed.map(async (provider) => {
      if (!provider.signedIn || credentials === undefined) return provider;
      const account = accountName(await credentials.read(provider.id).catch(() => undefined));
      return account === undefined ? provider : { ...provider, account };
    }),
  );
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The installation's ID in `file`, made on first use. A file that does not hold a UUID is
 * replaced; two Hosts making it at once both end up with the one written first. */
export function installationId(file: string): string {
  const read = (): string | undefined => {
    try {
      const text = readFileSync(file, 'utf8').trim();
      return UUID.test(text) ? text : undefined;
    } catch {
      return undefined;
    }
  };
  const existing = read();
  if (existing !== undefined) return existing;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, randomUUID(), { flag: 'wx' });
  } catch {
    // Another Host made it meanwhile, or the file holds no UUID: replace only the latter.
    if (read() === undefined) writeFileSync(file, randomUUID());
  }
  const made = read();
  if (made === undefined) throw new Error('the installation ID could not be stored');
  return made;
}

/** Codes of the errors Node's `fetch` reports when it cannot reach a server. */
const CONNECTION_CODE =
  /^(?:UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|CLOSED)|E(?:CONNREFUSED|CONNRESET|CONNABORTED|NOTFOUND|AI_AGAIN|TIMEDOUT|HOSTUNREACH|NETUNREACH|PIPE))$/u;

/**
 * Whether `error` says the server could not be reached: the code of the cause (`''` when there
 * is none, as when a flow rethrew only "fetch failed"), or `undefined` for any other failure.
 */
export function connectionFailure(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; isObject(current) && depth < 5; depth += 1) {
    const code = current.code;
    if (typeof code === 'string' && CONNECTION_CODE.test(code)) return code;
    current = current.cause;
  }
  return error instanceof Error && error.message.includes('fetch failed') ? '' : undefined;
}

/** The sign-ins running on this Host, by Core's login id. */
export class Logins {
  readonly #active = new Map<string, AbortController>();
  readonly #runtime: ModelRuntime;
  readonly #bridge: CoreBridge;
  readonly #log: (line: string) => void;
  readonly #deviceId: () => string;
  readonly #credentials: CredentialStore;
  readonly #fetch: typeof fetch;

  constructor(
    runtime: ModelRuntime,
    bridge: CoreBridge,
    log: (line: string) => void,
    options: {
      /** The installation's ID (Sign in with ChatGPT needs one). */
      readonly deviceId: () => string;
      /** Where the sign-in is stored: read back for the account's name (ADR-0083). */
      readonly credentials: CredentialStore;
      readonly fetch?: typeof fetch;
    },
  ) {
    this.#runtime = runtime;
    this.#bridge = bridge;
    this.#log = log;
    this.#deviceId = options.deviceId;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? fetch;
  }

  /** The name of the account just signed in to `provider`, when one can be told. */
  async #accountOf(provider: string): Promise<string | undefined> {
    const credential = await this.#credentials.read(provider).catch(() => undefined);
    return (
      accountName(credential) ??
      (provider === 'github-copilot' ? await githubLogin(credential, this.#fetch) : undefined)
    );
  }

  /** Signs in to `provider`; resolves once the credential is stored, with the account's name. */
  async start(loginId: string, provider: string): Promise<LoginStartResult> {
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
      await this.#runtime.login(provider, 'oauth', interaction, {
        agentName: 'PiArc',
        getDeviceId: this.#deviceId,
      });
      this.#log(`signed in to ${provider}`);
      const account = await this.#accountOf(provider);
      return account === undefined ? {} : { account };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AhpError('cancelled', 'The sign-in was cancelled');
      }
      if (error instanceof AhpError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const network = connectionFailure(error);
      // A provider the network cannot reach (often a regional block without a proxy): the
      // client offers the proxy settings for these (ADR-0082).
      throw network === undefined
        ? new AhpError('permissionDenied', message)
        : new AhpError(
            'permissionDenied',
            network === '' || message.includes(network) ? message : `${message} (${network})`,
            { details: { reason: 'network' } },
          );
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
