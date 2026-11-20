// Provider metadata is public. A credential entered in the form travels separately to Core
// and is never returned when editing an existing provider.
import type { MessageId } from '../../shared/i18n/index.js';

export const KINDS = ['builtin', 'cloud', 'custom', 'local'] as const;
export const APIS = ['openai-completions', 'anthropic-messages', 'openai-responses'] as const;
export type Kind = (typeof KINDS)[number];
type Api = (typeof APIS)[number];
export type Auth = 'bearer' | 'profile' | 'apiKey' | 'adc' | 'serviceAccount';

export interface Provider {
  id: string;
  kind: Kind;
  api?: Api;
  models?: string[];
  baseUrl?: string;
  region?: string;
  project?: string;
  auth?: Auth;
  profile?: string;
  credentialPath?: string;
  hasCredential: boolean;
}

/** A provider with sign-in (T29). */
export interface LoginProvider {
  id: string;
  name: string;
  label: string;
  subscription: boolean;
  signedIn: boolean;
}

/** A configured model with the catalog's values (T29). */
export interface CatalogEntry {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  vision: boolean;
  efforts: string[];
  toolReliability: string;
}

/** The user's settings for one model (T29). */
export interface ModelOverride {
  displayName?: string;
  contextWindow?: number;
  vision?: boolean;
  defaultEffort?: string;
  toolProfile?: 'default' | 'conservative';
}

export interface ProviderSettings {
  providers: Provider[];
  builtinProviders: { id: string; name: string }[];
  catalogRefresh: boolean;
  loginProviders: LoginProvider[];
  catalogModels: CatalogEntry[];
  models: Record<string, ModelOverride>;
  auxiliary: { provider: string; id: string } | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function validProvider(value: unknown): value is Provider {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    KINDS.some((kind) => kind === value.kind) &&
    typeof value.hasCredential === 'boolean' &&
    (value.api === undefined || APIS.some((api) => api === value.api)) &&
    (value.auth === undefined ||
      ['bearer', 'profile', 'apiKey', 'adc', 'serviceAccount'].some(
        (auth) => auth === value.auth,
      )) &&
    (value.models === undefined ||
      (Array.isArray(value.models) && value.models.every((m: unknown) => typeof m === 'string'))) &&
    ['baseUrl', 'region', 'project', 'profile', 'credentialPath'].every(
      (k) => value[k] === undefined || typeof value[k] === 'string',
    )
  );
}

export function parseSettings(text: string): ProviderSettings {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('providers' in value) ||
    !Array.isArray(value.providers) ||
    !('catalogRefresh' in value) ||
    typeof value.catalogRefresh !== 'boolean' ||
    !('builtinProviders' in value) ||
    !Array.isArray(value.builtinProviders) ||
    !value.providers.every(validProvider) ||
    !value.builtinProviders.every(
      (p: unknown) => record(p) && typeof p.id === 'string' && typeof p.name === 'string',
    )
  ) {
    throw new Error('Invalid provider settings');
  }
  const extra = value as Record<string, unknown>;
  const list = (key: string, valid: (v: unknown) => boolean): unknown[] => {
    const items = extra[key];
    return Array.isArray(items) ? items.filter(valid) : [];
  };
  const models = record(extra.models) ? extra.models : {};
  const auxiliary = extra.auxiliary;
  const known = value as Pick<ProviderSettings, 'providers' | 'builtinProviders'>;
  return {
    providers: known.providers,
    builtinProviders: known.builtinProviders,
    catalogRefresh: value.catalogRefresh,
    loginProviders: list(
      'loginProviders',
      (p) =>
        record(p) &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        typeof p.label === 'string' &&
        typeof p.signedIn === 'boolean',
    ) as LoginProvider[],
    catalogModels: list(
      'catalogModels',
      (m) =>
        record(m) &&
        typeof m.provider === 'string' &&
        typeof m.id === 'string' &&
        typeof m.name === 'string' &&
        typeof m.contextWindow === 'number' &&
        typeof m.vision === 'boolean' &&
        Array.isArray(m.efforts),
    ) as CatalogEntry[],
    models: models as Record<string, ModelOverride>,
    auxiliary:
      record(auxiliary) &&
      typeof auxiliary.provider === 'string' &&
      typeof auxiliary.id === 'string'
        ? { provider: auxiliary.provider, id: auxiliary.id }
        : null,
  };
}

export interface Form {
  kind: Kind;
  id: string;
  api: Api;
  models: string;
  baseUrl: string;
  region: string;
  project: string;
  key: string;
  removeKey: boolean;
  profile: string;
  credentialPath: string;
  auth: Auth;
}

export function makeForm(p?: Provider): Form {
  return {
    kind: p?.kind ?? 'custom',
    id: p?.id ?? '',
    api: p?.api ?? 'openai-completions',
    models: p?.models?.join('\n') ?? '',
    baseUrl: p?.baseUrl ?? '',
    region: p?.region ?? '',
    project: p?.project ?? '',
    key: '',
    removeKey: false,
    profile: p?.profile ?? '',
    credentialPath: p?.credentialPath ?? '',
    auth: p?.auth ?? (p?.id === 'amazon-bedrock' ? 'bearer' : 'apiKey'),
  };
}

export function hasEndpoint(kind: Kind): boolean {
  return kind === 'custom' || kind === 'local';
}

export function takesKey(form: Form): boolean {
  return form.kind !== 'cloud' || form.auth === 'bearer' || form.auth === 'apiKey';
}

export function entries(form: Form): string[] {
  return form.models
    .split(/\r?\n/u)
    .map((id) => id.trim())
    .filter(Boolean);
}

function validUrl(form: Form, keyed: boolean): boolean {
  try {
    if (!/^https?:\/\//u.test(form.baseUrl) || /\s|[?#\\]/u.test(form.baseUrl)) return false;
    const url = new URL(form.baseUrl);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      /^127(?:\.[0-9]{1,3}){3}$/u.test(url.hostname);
    return url.protocol === 'http:' && (!keyed || loopback);
  } catch {
    return false;
  }
}

export function fieldErrors(
  form: Form,
  settings: ProviderSettings,
  original?: Provider,
): Partial<Record<keyof Form, MessageId>> {
  const errors: Partial<Record<keyof Form, MessageId>> = {};
  const endpoint = hasEndpoint(form.kind);
  const existingKey =
    original?.hasCredential === true && takesKey(makeForm(original)) && !form.removeKey;
  const keyed = Boolean(form.key) || existingKey;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(form.id) ||
    (original === undefined && settings.providers.some((p) => p.id === form.id)) ||
    (endpoint && settings.builtinProviders.some((p) => p.id === form.id))
  ) {
    errors.id = 'providers.error.id';
  }
  if (endpoint) {
    if (!validUrl(form, keyed)) errors.baseUrl = 'providers.error.url';
    const models = entries(form);
    if (
      models.length === 0 ||
      models.length > 512 ||
      models.some((id) => id.length > 512 || /\p{Cc}/u.test(id)) ||
      new Set(models).size !== models.length
    )
      errors.models = 'providers.error.models';
    if (
      existingKey &&
      !form.key &&
      (form.baseUrl !== original.baseUrl || form.api !== original.api)
    ) {
      errors.key = 'providers.error.reenter';
    }
  } else if (!settings.builtinProviders.some((p) => p.id === form.id)) {
    errors.id = 'providers.error.provider';
  }
  if (takesKey(form)) {
    if (
      (!endpoint && !keyed) ||
      form.key.trim() !== form.key ||
      /\p{Cc}/u.test(form.key) ||
      form.key.length > 32768
    )
      errors.key = 'providers.error.key';
    if (form.key.includes('sk-ant-oat')) errors.key = 'providers.error.subscription';
  } else if (form.auth === 'profile') {
    if (!form.profile.trim()) errors.profile = 'providers.required';
  } else {
    if (!form.project.trim()) errors.project = 'providers.required';
    if (!form.region.trim()) errors.region = 'providers.required';
    if (form.auth === 'serviceAccount' && !form.credentialPath.trim())
      errors.credentialPath = 'providers.required';
  }
  return errors;
}

export function configOf(form: Form): Omit<Provider, 'hasCredential'> {
  const config: Omit<Provider, 'hasCredential'> = { id: form.id, kind: form.kind };
  if (hasEndpoint(form.kind))
    return { ...config, baseUrl: form.baseUrl, api: form.api, models: entries(form) };
  if (form.kind !== 'cloud') return config;
  config.auth = form.auth;
  if (form.region.trim() && form.auth !== 'apiKey') config.region = form.region.trim();
  if (form.auth === 'profile') config.profile = form.profile.trim();
  if (form.auth === 'adc' || form.auth === 'serviceAccount') config.project = form.project.trim();
  if (form.auth === 'serviceAccount') config.credentialPath = form.credentialPath.trim();
  return config;
}
