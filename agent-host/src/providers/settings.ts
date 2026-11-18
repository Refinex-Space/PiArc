// The settings Host accepts a structured form instead of Pi's interactive login prompts.
// ModelRuntime.login/logout use CoreCredentialStore's locked, persistent modify/delete.
import type { ApiKeyCredential, CredentialStore } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

import { AhpError } from '../protocol/errors.js';
import { isObject } from '../runtime/items.js';
import { assertAllowedKey } from './policy.js';

export async function credentialStatus(store: CredentialStore, id: string) {
  const credential = await store.read(id);
  const changeId = credential?.type === 'api_key' ? credential.env?.PIARC_CHANGE_ID : undefined;
  return { hasCredential: credential !== undefined, ...(changeId ? { changeId } : {}) };
}

export async function saveCredential(
  runtime: ModelRuntime,
  store: CredentialStore,
  id: string,
  value: unknown,
  keepKey: boolean,
) {
  if (value === undefined || value === null) {
    await runtime.logout(id);
    return {};
  }
  if (
    !isObject(value) ||
    value.type !== 'api_key' ||
    (value.key !== undefined && typeof value.key !== 'string')
  ) {
    throw new AhpError('invalidParams', 'Expected an API key credential');
  }
  const provider = runtime.getProvider(id);
  if (!provider?.auth.apiKey)
    throw new AhpError('invalidParams', 'Provider has no API key authentication');
  const env: Record<string, string> = {};
  if (value.env !== undefined) {
    if (!isObject(value.env)) throw new AhpError('invalidParams', 'Invalid provider fields');
    for (const [name, field] of Object.entries(value.env)) {
      if (typeof field !== 'string' || !ALLOWED_FIELDS.has(name))
        throw new AhpError('invalidParams', 'Invalid provider field');
      env[name] = field;
    }
  }
  let key = value.key;
  if (keepKey) {
    const previous = await store.read(id);
    if (
      previous?.type !== 'api_key' ||
      previous.env?.PIARC_BOUND_API !== env.PIARC_BOUND_API ||
      previous.env?.PIARC_BOUND_BASE_URL !== env.PIARC_BOUND_BASE_URL
    ) {
      throw new AhpError('invalidParams', 'Enter a new key for the changed endpoint');
    }
    key = previous.key;
  }
  assertAllowedKey(key);
  const credential: ApiKeyCredential = {
    type: 'api_key',
    ...(key === undefined ? {} : { key }),
    env,
  };
  // This Host serves settings only. Restore any native registration (including the subscription
  // policy) after the one-shot form login, and never leave a closure retaining the secret.
  const previous = runtime.getRegisteredNativeProvider(id);
  runtime.registerNativeProvider({
    ...provider,
    auth: { apiKey: { ...provider.auth.apiKey, login: () => Promise.resolve(credential) } },
  });
  try {
    await runtime.login(id, 'api_key', {
      prompt: () => Promise.reject(new Error('Unexpected prompt for a submitted credential')),
      notify: () => undefined,
    });
  } finally {
    if (previous) runtime.registerNativeProvider(previous);
    else runtime.unregisterProvider(id);
  }
  return {};
}

const ALLOWED_FIELDS = new Set([
  'AWS_PROFILE',
  'AWS_REGION',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'PIARC_BOUND_BASE_URL',
  'PIARC_BOUND_API',
  'PIARC_CHANGE_ID',
]);
