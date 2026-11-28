// ADR-0083: accounts, turned-off providers, connection tests and model lists in the provider view.
import { describe, expect, it } from 'vitest';

import {
  accountsByProvider,
  parseDiscovered,
  parseSettings,
  parseTestResult,
  withModel,
} from './provider-form.js';

const base = { providers: [], builtinProviders: [], catalogRefresh: false };

describe('the provider view (ADR-0083)', () => {
  it('reads the accounts, the providers turned off and who is signed in', () => {
    const settings = parseSettings(
      JSON.stringify({
        ...base,
        disabled: ['deepseek', 3],
        loginProviders: [
          {
            id: 'openai-codex',
            name: 'OpenAI Codex',
            label: 'ChatGPT',
            subscription: true,
            signedIn: true,
            account: 'ann@example.com',
          },
          { id: 'xai', name: 'xAI', label: 'X', subscription: false, signedIn: false, account: 7 },
        ],
        accounts: [
          { provider: 'openai-codex', id: 'a1', label: 'ann@example.com', active: true },
          { provider: 'openai-codex', id: 'a2', label: 'bob@example.com' },
          { provider: 'openai-codex', id: 3 },
        ],
      }),
    );
    expect(settings.disabled).toEqual(['deepseek']);
    expect(settings.loginProviders.map((p) => p.id)).toEqual(['openai-codex']);
    expect(settings.loginProviders[0]?.account).toBe('ann@example.com');
    expect(settings.accounts).toEqual([
      { provider: 'openai-codex', id: 'a1', label: 'ann@example.com', active: true },
      { provider: 'openai-codex', id: 'a2', label: 'bob@example.com', active: false },
    ]);
  });

  it('defaults to nothing turned off and no accounts for an older Core', () => {
    const settings = parseSettings(JSON.stringify(base));
    expect(settings.disabled).toEqual([]);
    expect(settings.accounts).toEqual([]);
  });

  it('groups accounts by provider with the one in use first', () => {
    const groups = accountsByProvider([
      { provider: 'p', id: 'aside', active: false },
      { provider: 'q', id: 'only', active: true },
      { provider: 'p', id: 'in-use', active: true },
    ]);
    expect(groups.get('p')?.map((a) => a.id)).toEqual(['in-use', 'aside']);
    expect(groups.get('q')?.map((a) => a.id)).toEqual(['only']);
  });

  it('reads a connection test and a model list', () => {
    expect(parseTestResult('{"ok":true,"model":"m","latencyMs":412}')).toEqual({
      ok: true,
      model: 'm',
      latencyMs: 412,
      network: false,
    });
    expect(parseTestResult('{"ok":false,"message":"fetch failed","network":true}')).toEqual({
      ok: false,
      message: 'fetch failed',
      network: true,
    });
    expect(() => parseTestResult('{"model":"m"}')).toThrow();
    expect(parseDiscovered('{"models":["a","b",1]}')).toEqual(['a', 'b']);
    expect(() => parseDiscovered('{"models":"a"}')).toThrow();
  });

  it('adds a checked model to the list and removes an unchecked one', () => {
    expect(withModel('one\r\ntwo\n', 'three', true)).toBe('one\ntwo\nthree');
    expect(withModel('one\ntwo', 'two', true)).toBe('one\ntwo');
    expect(withModel('one\n two \nthree', 'two', false)).toBe('one\nthree');
    expect(withModel('', 'one', true)).toBe('one');
  });
});
