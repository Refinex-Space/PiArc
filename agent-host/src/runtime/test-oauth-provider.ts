// A model provider with OAuth login and token refresh against a local test token endpoint,
// for the credential tests only (`--test-oauth-provider <json file>`; Core never passes it).
//
// It exercises pi-ai's own OAuth path end to end: `ModelRuntime.login()` stores the credential
// through the credential store (`modify`), and a request whose token expires within pi-ai's
// refresh window (five minutes) refreshes it inside `modify`. Models speak the OpenAI Chat
// Completions wire format to the strict mock provider. Every token carries a non-secret
// `label` that requests send as `x-piarc-test-token`, so a test can tell which token a
// request used without seeing the token (the mock redacts credential headers).
//
// It is not an Anthropic subscription login and does not touch one (ADR-0006).
import { createProvider } from '@earendil-works/pi-ai';
import type { Model, OAuthCredential } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export interface TestOAuthProviderConfig {
  readonly id: string;
  /** OpenAI-compatible base URL of the mock provider. */
  readonly baseUrl: string;
  /** Token endpoint: POST JSON `{ grantType, code | refreshToken }`. */
  readonly tokenUrl: string;
  readonly models: readonly { id: string; contextWindow: number; maxTokens: number }[];
  /** When present, the Agent Host logs in with this authorization code once it starts. */
  readonly loginCode?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The configuration in `value`, or a description of what is wrong with it. */
export function parseTestOAuthProvider(value: unknown): TestOAuthProviderConfig | string {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.baseUrl !== 'string' ||
    typeof value.tokenUrl !== 'string' ||
    !Array.isArray(value.models)
  ) {
    return 'expected { id, baseUrl, tokenUrl, models, loginCode? }';
  }
  const models: { id: string; contextWindow: number; maxTokens: number }[] = [];
  for (const model of value.models) {
    if (
      !isRecord(model) ||
      typeof model.id !== 'string' ||
      typeof model.contextWindow !== 'number' ||
      typeof model.maxTokens !== 'number'
    ) {
      return 'each model needs { id, contextWindow, maxTokens }';
    }
    models.push({ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens });
  }
  if (value.loginCode !== undefined && typeof value.loginCode !== 'string') {
    return 'loginCode must be a string';
  }
  return {
    id: value.id,
    baseUrl: value.baseUrl,
    tokenUrl: value.tokenUrl,
    models,
    ...(typeof value.loginCode === 'string' ? { loginCode: value.loginCode } : {}),
  };
}

async function exchange(
  tokenUrl: string,
  body: object,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`token endpoint answered ${String(response.status)}`);
  }
  const token: unknown = await response.json();
  if (
    !isRecord(token) ||
    typeof token.accessToken !== 'string' ||
    typeof token.refreshToken !== 'string' ||
    typeof token.expiresInMs !== 'number' ||
    typeof token.label !== 'string'
  ) {
    throw new Error('token endpoint returned a malformed token');
  }
  return {
    type: 'oauth',
    access: token.accessToken,
    refresh: token.refreshToken,
    expires: Date.now() + token.expiresInMs,
    label: token.label,
  };
}

/** Registers the provider with `runtime`. */
export function registerTestOAuthProvider(
  runtime: ModelRuntime,
  config: TestOAuthProviderConfig,
): void {
  const models: Model<'openai-completions'>[] = config.models.map((m) => ({
    id: m.id,
    name: m.id,
    api: 'openai-completions',
    provider: config.id,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  }));
  runtime.registerNativeProvider(
    createProvider({
      id: config.id,
      name: 'PiArc test OAuth provider',
      baseUrl: config.baseUrl,
      auth: {
        oauth: {
          name: 'PiArc test OAuth',
          isSubscription: false,
          login: async (interaction) => {
            const code = await interaction.prompt({
              type: 'manual_code',
              message: 'Authorization code',
            });
            return exchange(
              config.tokenUrl,
              { grantType: 'authorization_code', code },
              interaction.signal,
            );
          },
          refresh: (credential, signal) =>
            exchange(
              config.tokenUrl,
              { grantType: 'refresh_token', refreshToken: credential.refresh },
              signal,
            ),
          toAuth: (credential) =>
            Promise.resolve({
              apiKey: credential.access,
              headers: {
                'x-piarc-test-token':
                  typeof credential.label === 'string' ? credential.label : 'unlabelled',
              },
            }),
        },
      },
      models,
      api: openAICompletionsApi(),
    }),
  );
}

/** Logs in with the configured authorization code, as a user finishing the flow would. */
export async function testLogin(
  runtime: ModelRuntime,
  config: TestOAuthProviderConfig,
  log: (line: string) => void,
): Promise<void> {
  const code = config.loginCode;
  if (code === undefined) {
    return;
  }
  try {
    await runtime.login(config.id, 'oauth', {
      prompt: () => Promise.resolve(code),
      notify: () => undefined,
    });
    log(`test login for ${config.id} stored its credential`);
  } catch (error) {
    log(
      `test login for ${config.id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
