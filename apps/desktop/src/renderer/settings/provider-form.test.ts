import { describe, expect, it } from 'vitest';
import {
  configOf,
  parseSettings,
  fieldErrors,
  makeForm,
  type ProviderSettings,
  type Provider,
} from './provider-form.js';
const settings: ProviderSettings = {
  providers: [],
  builtinProviders: [
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'google-vertex', name: 'Google Vertex' },
  ],
  catalogRefresh: true,
  loginProviders: [],
  catalogModels: [],
  models: {},
  auxiliary: null,
  auxiliaryAlias: null,
  aliases: {},
};
describe('provider settings', () => {
  const custom = {
    ...makeForm(),
    id: 'relay',
    baseUrl: 'https://relay.example/v1',
    models: 'chat\nreason',
    key: 'test',
  };
  it('keeps credentials out of the public configuration and rejects subscription tokens on custom hosts', () => {
    expect(configOf(custom)).toEqual({
      kind: 'custom',
      id: 'relay',
      baseUrl: custom.baseUrl,
      models: ['chat', 'reason'],
      api: 'openai-completions',
    });
    expect(
      fieldErrors(
        { ...custom, api: 'anthropic-messages', key: 'prefix-sk-ant-oat-test' },
        settings,
      ),
    ).toEqual({ key: 'providers.error.subscription' });
    expect(fieldErrors({ ...custom, id: 'anthropic' }, settings)).toMatchObject({
      id: 'providers.error.id',
    });
  });
  it('validates the endpoint destination, model list and changes of credential recipients', () => {
    for (const baseUrl of [
      'data:text/plain,hi',
      'https://relay.example/?key=secret',
      'https://key@relay.example',
      'http://relay.example',
      'http://127.example.org/v1',
      'https://relay.example/#x',
    ])
      expect(fieldErrors({ ...custom, baseUrl }, settings)).toMatchObject({
        baseUrl: 'providers.error.url',
      });
    expect(fieldErrors({ ...custom, baseUrl: 'http://127.0.0.1:8080/v1' }, settings)).toEqual({});
    expect(fieldErrors({ ...custom, models: 'foo\nfoo' }, settings)).toMatchObject({
      models: 'providers.error.models',
    });
    const saved: Provider = { ...configOf(custom), hasCredential: true };
    expect(
      fieldErrors({ ...makeForm(saved), baseUrl: 'https://new.example' }, settings, saved),
    ).toMatchObject({ key: 'providers.error.reenter' });
    expect(
      fieldErrors(
        { ...makeForm(saved), baseUrl: 'https://new.example', removeKey: true },
        settings,
        saved,
      ),
    ).toEqual({});
  });
  it('serializes only fields used by the selected cloud authentication method', () => {
    const adc = {
      ...makeForm(),
      kind: 'cloud' as const,
      id: 'google-vertex',
      auth: 'adc' as const,
      project: 'project',
      region: 'us-central1',
      credentialPath: 'old-file',
      key: 'old',
    };
    expect(fieldErrors(adc, settings)).toEqual({});
    expect(configOf(adc)).toEqual({
      kind: 'cloud',
      id: 'google-vertex',
      auth: 'adc',
      project: 'project',
      region: 'us-central1',
    });
    expect(
      fieldErrors({ ...adc, auth: 'serviceAccount', credentialPath: '' }, settings),
    ).toMatchObject({ credentialPath: 'providers.required' });
  });
});

describe('sign-in and model settings in the provider view (T29)', () => {
  it('reads login providers, catalog models, per-model settings and the auxiliary model', () => {
    const parsed = parseSettings(
      JSON.stringify({
        providers: [],
        builtinProviders: [],
        catalogRefresh: false,
        loginProviders: [
          {
            id: 'github-copilot',
            name: 'GitHub Copilot',
            label: 'GitHub',
            subscription: true,
            signedIn: false,
          },
          { id: 'broken' },
        ],
        catalogModels: [
          {
            provider: 'p',
            id: 'm',
            name: 'M',
            contextWindow: 1000,
            vision: true,
            efforts: ['off'],
            toolReliability: 'low',
          },
        ],
        models: { 'p/m': { contextWindow: 2048 } },
        auxiliary: { provider: 'p', id: 'm' },
      }),
    );
    expect(parsed.loginProviders.map((p) => p.id)).toEqual(['github-copilot']);
    expect(parsed.catalogModels).toHaveLength(1);
    expect(parsed.models['p/m']?.contextWindow).toBe(2048);
    expect(parsed.auxiliary).toEqual({ provider: 'p', id: 'm' });
    const old = parseSettings(
      JSON.stringify({ providers: [], builtinProviders: [], catalogRefresh: true }),
    );
    expect(old.loginProviders).toEqual([]);
    expect(old.auxiliary).toBeNull();
  });
});
