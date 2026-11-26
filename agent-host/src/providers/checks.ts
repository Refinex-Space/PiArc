// Checks the settings window runs on the settings Host (ADR-0083): one short request to a model
// of a provider (`models/test`), and the model list of an endpoint (`models/discover`).
import type { CredentialStore } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type {
  ModelsDiscoverParams,
  ModelsDiscoverResult,
  ModelsTestParams,
  ModelsTestResult,
} from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import { isObject } from '../runtime/items.js';
import { classifyTurnError } from '../runtime/turn-errors.js';
import { connectionFailure } from './login.js';

/** How long the test request may take. */
const TEST_TIMEOUT_MS = 30_000;
/** How long a model list request may take. */
const DISCOVER_TIMEOUT_MS = 15_000;
/** Most model ids kept from a list, as a custom provider may have. */
const MAX_MODELS = 512;

/** Longest failure message kept for the settings window. */
const MAX_MESSAGE = 300;

/**
 * A provider's failure as one readable line: `404: {"message": "…"}` becomes `404: …`, the
 * message inside the JSON body; anything longer than {@link MAX_MESSAGE} is cut.
 */
export function tidyMessage(message: string): string {
  const text = message.trim();
  const body = /^(\d{3})[^{]*?(\{[\s\S]*\})$/u.exec(text);
  if (body?.[1] !== undefined && body[2] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(body[2]);
      const inner = isObject(parsed)
        ? typeof parsed.message === 'string'
          ? parsed.message
          : isObject(parsed.error) && typeof parsed.error.message === 'string'
            ? parsed.error.message
            : typeof parsed.error === 'string'
              ? parsed.error
              : undefined
        : undefined;
      if (inner !== undefined) return tidyMessage(`${body[1]}: ${inner}`);
    } catch {
      // Not JSON after all: cut it as it is.
    }
  }
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

function failed(model: string | undefined, message: string): ModelsTestResult {
  const network = classifyTurnError(undefined, message).kind === 'network';
  return {
    ok: false,
    ...(model === undefined ? {} : { model }),
    message: tidyMessage(message),
    ...(network ? { network: true } : {}),
  };
}

/** One short request to `params.model`, or the provider's first available model. */
export async function testProvider(
  runtime: ModelRuntime,
  params: ModelsTestParams,
): Promise<ModelsTestResult> {
  const available = await runtime.getAvailable(params.provider);
  const model = params.model == null ? available[0] : available.find((m) => m.id === params.model);
  if (model === undefined) {
    return {
      ok: false,
      message: `${params.provider} has no model to ask: check its key or sign-in`,
    };
  }
  const started = performance.now();
  try {
    const reply = await runtime.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] },
      { maxTokens: 16, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) },
    );
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
      return failed(model.id, reply.errorMessage ?? 'The model did not answer');
    }
    return { ok: true, model: model.id, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = connectionFailure(error);
    return code === undefined
      ? failed(model.id, message)
      : {
          ok: false,
          model: model.id,
          message: code === '' || message.includes(code) ? message : `${message} (${code})`,
          network: true,
        };
  }
}

/** The ids in a model list: OpenAI's and Anthropic's `{ data: [{ id }] }`, Ollama's
 * `{ models: [{ name }] }`, or a plain array. */
export function modelIds(body: unknown): string[] {
  const items = Array.isArray(body)
    ? body
    : isObject(body) && Array.isArray(body.data)
      ? body.data
      : isObject(body) && Array.isArray(body.models)
        ? body.models
        : [];
  const ids = items.flatMap((item: unknown) => {
    const id =
      typeof item === 'string' ? item : isObject(item) ? (item.id ?? item.name) : undefined;
    return typeof id === 'string' && id !== '' && id.length <= 512 && !/\p{Cc}/u.test(id)
      ? [id]
      : [];
  });
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_MODELS);
}

/** The key the request may send: typed, or the one stored for the provider Core named when it
 * is bound to this very address and protocol. */
async function keyOf(
  params: ModelsDiscoverParams,
  credentials: CredentialStore,
): Promise<string | undefined> {
  if (params.key != null) return params.key;
  if (params.storedKeyOf == null) return undefined;
  const stored = await credentials.read(params.storedKeyOf);
  if (stored?.type !== 'api_key') return undefined;
  const env = stored.env ?? {};
  // The key is bound to the endpoint it was saved for (T21); never send it anywhere else.
  if (env.PIARC_BOUND_BASE_URL !== params.baseUrl || env.PIARC_BOUND_API !== params.api) {
    return undefined;
  }
  return stored.key;
}

function urls(params: ModelsDiscoverParams): string[] {
  const base = params.baseUrl.replace(/\/+$/u, '');
  return params.api === 'anthropic-messages'
    ? [`${base}/v1/models`, `${base}/models`]
    : [`${base}/models`];
}

function headers(params: ModelsDiscoverParams, key: string | undefined): Record<string, string> {
  if (key === undefined) return { Accept: 'application/json' };
  return params.api === 'anthropic-messages'
    ? { Accept: 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Accept: 'application/json', Authorization: `Bearer ${key}` };
}

function refused(status: number, url: string): AhpError {
  const message = `${new URL(url).pathname} answered HTTP ${String(status)}`;
  if (status === 401 || status === 403) return new AhpError('permissionDenied', message);
  if (status === 404) return new AhpError('notFound', message);
  return new AhpError('invalidParams', message);
}

/** The endpoint's model ids (`models/discover`). */
export async function discoverModels(
  params: ModelsDiscoverParams,
  credentials: CredentialStore,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelsDiscoverResult> {
  const key = await keyOf(params, credentials);
  let last: AhpError | undefined;
  for (const url of urls(params)) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: headers(params, key),
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = connectionFailure(error);
      throw new AhpError(
        'invalidParams',
        code === undefined || code === '' ? message : `${message} (${code})`,
        code === undefined ? {} : { details: { reason: 'network' } },
      );
    }
    if (!response.ok) {
      last = refused(response.status, url);
      // Anthropic-compatible endpoints differ on the path: try the next one on 404 only.
      if (response.status === 404) continue;
      throw last;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AhpError('invalidParams', 'The endpoint did not answer with a model list');
    }
    return { models: modelIds(body) };
  }
  throw last ?? new AhpError('notFound', 'The endpoint has no model list');
}
