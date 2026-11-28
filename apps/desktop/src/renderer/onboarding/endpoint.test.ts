import { expect, it } from 'vitest';

import { endpointId } from './endpoint.js';

it('names an endpoint after its site and keeps the id free', () => {
  const none = new Set<string>();
  expect(endpointId('custom', 'https://api.example.com/v1', none)).toBe('example');
  expect(endpointId('custom', 'https://llm.corp.internal/v1', none)).toBe('corp');
  expect(endpointId('custom', 'http://127.0.0.1:8080/v1', none)).toBe('custom');
  expect(endpointId('custom', 'http://localhost:1234/v1', none)).toBe('custom');
  expect(endpointId('custom', 'http://[::1]:8080/v1', none)).toBe('custom');
  expect(endpointId('custom', 'not a url', none)).toBe('custom');
  expect(endpointId('local', 'http://localhost:11434/v1', none)).toBe('local');
  expect(endpointId('local', '', new Set(['local', 'local-2']))).toBe('local-3');
  expect(endpointId('custom', 'https://api.deepseek.com', new Set(['deepseek']))).toBe(
    'deepseek-2',
  );
  for (const id of ['example', 'custom', 'local-3']) {
    expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,95}$/u);
  }
});
