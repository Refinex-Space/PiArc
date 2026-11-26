import { describe, expect, it } from 'vitest';

import { next } from './SignInSection.js';

const provider = {
  id: 'openai',
  name: 'OpenAI',
  label: 'ChatGPT',
  subscription: true,
  signedIn: false,
};

const event = (interaction: Record<string, unknown>) => ({
  loginId: 'login-1',
  provider: 'openai',
  state: 'interaction',
  interaction,
});

describe('the sign-in steps', () => {
  it('keeps the authorization page on screen while a pasted redirect URL is asked for', () => {
    const view = [
      event({ type: 'authUrl', url: 'https://auth.example/authorize?x=1' }),
      event({ type: 'prompt', kind: 'manualCode', message: 'Paste the redirect URL' }),
    ].reduce(next, { provider });
    expect(view.link).toMatchObject({ type: 'authUrl', url: 'https://auth.example/authorize?x=1' });
    expect(view.question).toMatchObject({ kind: 'manualCode' });
    expect(view.loginId).toBe('login-1');
  });

  it('replaces a question with the next one, and a status line keeps the steps', () => {
    const view = [
      event({ type: 'prompt', kind: 'text', message: 'Enterprise domain (blank for github.com)' }),
      event({ type: 'deviceCode', userCode: 'ABCD-1234', verificationUri: 'https://x.example' }),
      event({ type: 'progress', message: 'Waiting…' }),
      event({ type: 'prompt', kind: 'select', message: 'Pick', options: [] }),
    ].reduce(next, { provider });
    expect(view.link).toMatchObject({ type: 'deviceCode', userCode: 'ABCD-1234' });
    expect(view.question).toMatchObject({ kind: 'select' });
    expect(view.note).toBe('Waiting…');
  });

  it('keeps the links of an information step', () => {
    const view = next(
      { provider },
      event({
        type: 'info',
        message: 'See',
        links: [{ url: 'https://docs.example', label: 'Docs' }, 3],
      }),
    );
    expect(view.links).toEqual([{ url: 'https://docs.example', label: 'Docs' }]);
  });

  it('ignores another sign-in and ends with the outcome', () => {
    const started = next({ provider }, event({ type: 'progress', message: 'Starting' }));
    const other = next(started, {
      ...event({ type: 'progress', message: 'x' }),
      loginId: 'login-2',
    });
    expect(other).toBe(started);
    const ended = next(started, {
      loginId: 'login-1',
      provider: 'openai',
      state: 'failed',
      message: 'fetch failed',
    });
    expect(ended.outcome).toEqual({ state: 'failed', message: 'fetch failed' });
    const unreachable = next(started, {
      loginId: 'login-1',
      provider: 'openai',
      state: 'failed',
      message: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)',
      network: true,
    });
    expect(unreachable.outcome?.network).toBe(true);
  });
});
