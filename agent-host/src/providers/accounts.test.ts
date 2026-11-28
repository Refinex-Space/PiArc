import type { Credential } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import { accountName, githubLogin, jwtClaims } from './accounts.js';

const jwt = (claims: object) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;

const oauth = (fields: Record<string, unknown>): Credential => ({
  type: 'oauth',
  access: 'opaque',
  refresh: 'r',
  expires: 1,
  ...fields,
});

describe('accountName', () => {
  it('reads the name a flow keeps, then the claims of its tokens', () => {
    expect(accountName(oauth({ email: 'ann@example.com' }))).toBe('ann@example.com');
    expect(accountName(oauth({ access: jwt({ email: 'bob@example.com' }) }))).toBe(
      'bob@example.com',
    );
    expect(
      accountName(
        oauth({
          access: jwt({ 'https://api.openai.com/profile': { email: 'cat@example.com' } }),
        }),
      ),
    ).toBe('cat@example.com');
    expect(accountName(oauth({ idToken: jwt({ preferred_username: 'dee' }) }))).toBe('dee');
  });

  it('tells nothing for an API key, an opaque token or an unreadable claim', () => {
    expect(accountName({ type: 'api_key', key: 'k' })).toBeUndefined();
    expect(accountName(oauth({}))).toBeUndefined();
    expect(accountName(oauth({ access: 'a.b.c' }))).toBeUndefined();
    expect(accountName(oauth({ email: 'x'.repeat(300) }))).toBeUndefined();
    expect(accountName(undefined)).toBeUndefined();
    expect(jwtClaims('only.two')).toBeUndefined();
  });
});

describe('githubLogin', () => {
  it('asks GitHub, or the Enterprise server, for the login of the token', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ login: 'octo' }), { status: 200 })),
    );
    expect(await githubLogin(oauth({ refresh: 'gho_x' }), fetchImpl)).toBe('octo');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer gho_x' }) as unknown,
      }),
    );
    await githubLogin(oauth({ enterpriseUrl: 'https://git.example.com/' }), fetchImpl);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://git.example.com/api/v3/user',
      expect.anything(),
    );
  });

  it('gives up quietly when GitHub refuses or is out of reach', async () => {
    expect(
      await githubLogin(oauth({}), () => Promise.resolve(new Response('', { status: 401 }))),
    ).toBeUndefined();
    expect(
      await githubLogin(oauth({}), () => Promise.reject(new TypeError('fetch failed'))),
    ).toBeUndefined();
  });
});
