import { describe, expect, it } from 'vitest';

import { AppStore } from '../store/app-store.js';
import { startSession } from './start-session.js';

function fakeApi(failPrompt = false) {
  const calls: string[] = [];
  const api = {
    createSession: (workspace: string) => {
      calls.push(`create ${workspace}`);
      return Promise.resolve(JSON.stringify({ sessionId: 'new' }));
    },
    prompt: (id: string) => {
      calls.push(`prompt ${id}`);
      return failPrompt
        ? Promise.reject(new Error('the model is not reachable'))
        : Promise.resolve(JSON.stringify({ turnId: 't1' }));
    },
    closeSession: (id: string) => {
      calls.push(`close ${id}`);
      return Promise.resolve('null');
    },
    storeAttachment: () => Promise.reject(new Error('no attachments here')),
    setSessionEffort: (id: string, effort: string) => {
      calls.push(`effort ${id} ${effort}`);
      return Promise.resolve('null');
    },
    setPermissionMode: (id: string, mode: string) => {
      calls.push(`mode ${id} ${mode}`);
      return Promise.resolve();
    },
    setSessionModel: (id: string, provider: string, model: string) => {
      calls.push(`model ${id} ${provider}/${model}`);
      return Promise.resolve('null');
    },
  };
  return { api, calls };
}

const base = {
  store: new AppStore(),
  workspace: '/w',
  text: 'Hello',
  clientId: 'c1',
  watch: () => () => undefined,
  onStep: () => undefined,
};

describe('starting a session', () => {
  it('sends the first message to the draft, with the model chosen since', async () => {
    const { api, calls } = fakeApi();
    const id = await startSession({
      ...base,
      api,
      sessionId: 'draft',
      model: { provider: 'p', id: 'm' },
      effort: 'high',
      mode: 'plan',
    });
    expect(id).toBe('draft');
    expect(calls).toEqual([
      'model draft p/m',
      'effort draft high',
      'mode draft plan',
      'prompt draft',
    ]);
  });

  it('keeps the draft when its first message fails', async () => {
    const { api, calls } = fakeApi(true);
    await expect(startSession({ ...base, api, sessionId: 'draft' })).rejects.toThrow(
      'not reachable',
    );
    expect(calls).toEqual(['prompt draft']);
  });

  it('closes a session it created when the first message fails', async () => {
    const { api, calls } = fakeApi(true);
    await expect(startSession({ ...base, api })).rejects.toThrow('not reachable');
    expect(calls).toEqual(['create /w', 'prompt new', 'close new']);
  });
});
