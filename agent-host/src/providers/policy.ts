// Install the provider policy before Pi creates sessions or starts its first catalog refresh.
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  lazyStream,
  type AnyModel,
  type Api,
  type Model,
  type AssistantMessageEvent,
  type AuthResult,
  type Context,
} from '@earendil-works/pi-ai';
import type { ModelRuntime, ModelRuntimeAuthOverrides } from '@earendil-works/pi-coding-agent';

import { AhpError } from '../protocol/errors.js';

export function assertAllowedKey(key: string | undefined): void {
  // Pi 1.5.2 checks includes(), not a prefix, and does so on custom Anthropic endpoints too.
  if (key?.includes('sk-ant-oat')) {
    throw new AhpError('permissionDenied', 'Anthropic subscription credentials are disabled');
  }
}

function endpoint(address: string): string {
  return new URL(address).href.replace(/\/+$/u, '');
}

function checkResolution(model: AnyModel | string, result: AuthResult): AuthResult {
  assertAllowedKey(result.auth.apiKey);
  if (result.source === 'ANTHROPIC_AUTH_TOKEN' || result.source === 'ANTHROPIC_OAUTH_TOKEN') {
    throw new AhpError('permissionDenied', 'Anthropic environment credentials are disabled');
  }
  const env = { ...result.env };
  const boundUrl = env.PIARC_BOUND_BASE_URL;
  const boundApi = env.PIARC_BOUND_API;
  if (boundUrl !== undefined || boundApi !== undefined) {
    if (
      typeof model === 'string' ||
      !boundUrl ||
      model.api !== boundApi ||
      endpoint(boundUrl) !== endpoint(result.auth.baseUrl ?? model.baseUrl)
    ) {
      throw new AhpError('permissionDenied', 'The credential belongs to a different endpoint');
    }
  }
  delete env.PIARC_BOUND_BASE_URL;
  delete env.PIARC_BOUND_API;
  delete env.PIARC_CHANGE_ID;
  return { ...result, env };
}

/** Scrub server-echoed keys on the stream before Pi persists an error or issues a retry. */
async function* redactErrors(source: AsyncIterable<AssistantMessageEvent>, secrets: Set<string>) {
  const redact = (text: string) => {
    let safe = text;
    for (const value of secrets) safe = safe.replaceAll(value, '[REDACTED]');
    return safe;
  };
  for await (const event of source) {
    const message =
      event.type === 'error' ? event.error : event.type === 'done' ? event.message : event.partial;
    if (message.errorMessage) message.errorMessage = redact(message.errorMessage);
    for (const diagnostic of message.diagnostics ?? []) {
      if (diagnostic.error) {
        diagnostic.error.message = redact(diagnostic.error.message);
        if (diagnostic.error.stack) diagnostic.error.stack = redact(diagnostic.error.stack);
      }
      // Diagnostic details can contain unstructured adapter data. Keep only safe metadata.
      delete diagnostic.details;
    }
    yield event;
  }
}

/** Earlier conversation images are Pi's to project. New user input since the last assistant
 * message includes any steers Pi has just removed from its own queue. */
function newestInputHasImage(context: Context): boolean {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === 'assistant') return false;
    if (
      message?.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image')
    )
      return true;
  }
  return false;
}

/** `vision` says whether a model accepts images (the user's per-model setting, T29). */
export function installProviderPolicy(
  runtime: ModelRuntime,
  vision: (model: Model<Api>) => boolean = (model) => model.input.includes('image'),
): void {
  const anthropic = runtime.getProvider('anthropic');
  if (!anthropic?.auth.apiKey) throw new Error('The Anthropic API key adapter is missing');
  runtime.registerNativeProvider({ ...anthropic, auth: { apiKey: anthropic.auth.apiKey } });

  const login = runtime.login.bind(runtime);
  runtime.login = (id, type, interaction, options) => {
    if (id === 'anthropic' && type === 'oauth') {
      return Promise.reject(
        new AhpError('permissionDenied', 'Anthropic subscription login is disabled'),
      );
    }
    return login(id, type, interaction, options);
  };

  const requestSecrets = new AsyncLocalStorage<Set<string>>();
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = async (model: AnyModel | string, options?: ModelRuntimeAuthOverrides) => {
    const result =
      typeof model === 'string' ? await getAuth(model, options) : await getAuth(model, options);
    if (!result) return undefined;
    if (typeof model !== 'string' && (model.type === undefined || model.type === 'chat')) {
      const current = runtime.getModel(model.provider, model.id);
      if (current?.api !== model.api || current.baseUrl !== model.baseUrl) {
        throw new AhpError('permissionDenied', 'The selected model endpoint has changed');
      }
    }
    const safe = checkResolution(model, result);
    const secrets = requestSecrets.getStore();
    if (secrets) {
      if (safe.auth.apiKey) secrets.add(safe.auth.apiKey);
      for (const [key, value] of Object.entries({ ...safe.auth.headers, ...safe.env })) {
        if (value && /authorization|token|secret|api[-_]?key/i.test(key)) {
          secrets.add(value);
          if (value.startsWith('Bearer ')) secrets.add(value.slice(7));
        }
      }
    }
    return safe;
  };

  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => {
    const secrets = new Set<string>();
    return lazyStream(
      model,
      () => {
        const live = runtime.getModel(model.provider, model.id);
        if ((live === undefined || !vision(live)) && newestInputHasImage(context)) {
          return Promise.reject(
            new AhpError(
              'invalidParams',
              'Image attachments are not supported by the selected model',
            ),
          );
        }
        const source = requestSecrets.run(secrets, () => stream(model, context, options));
        return Promise.resolve(redactErrors(source, secrets));
      },
      undefined,
      options?.signal,
    );
  };
}
