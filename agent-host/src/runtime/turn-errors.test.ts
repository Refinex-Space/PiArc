import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { classifyTurnError, stopFailureType } from './turn-errors.js';

function failed(errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: 'piarc-mock',
    model: 'mock-large',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage,
    timestamp: 0,
  };
}

describe('classifyTurnError', () => {
  it.each([
    [
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      'auth',
      false,
    ],
    ['No API key found for piarc-mock', 'auth', false],
    ['429 {"error":{"type":"rate_limit_error","message":"Too many requests"}}', 'rateLimit', true],
    ['insufficient_quota: You exceeded your current quota', 'rateLimit', false],
    ['529 {"error":{"type":"overloaded_error","message":"Overloaded"}}', 'provider', true],
    ['500 Internal server error', 'provider', true],
    ['fetch failed', 'network', true],
    ['getaddrinfo ENOTFOUND api.example.com', 'network', true],
    ['400 {"error":{"type":"invalid_request_error","message":"bad"}}', 'invalidRequest', false],
    ['something odd happened', 'internal', true],
  ] as const)('%s → %s', (message, kind, retryable) => {
    expect(classifyTurnError(failed(message), message)).toEqual({ kind, retryable });
  });

  it('recognizes a context overflow with pi-ai’s own rule', () => {
    const message = 'prompt is too long: 250000 tokens > 200000 maximum';
    expect(classifyTurnError(failed(message), message)).toEqual({
      kind: 'contextOverflow',
      retryable: false,
    });
  });

  it('classifies errors thrown before any response by their text', () => {
    expect(classifyTurnError(undefined, 'No model selected')).toEqual({
      kind: 'internal',
      retryable: true,
    });
  });
});

describe('stopFailureType', () => {
  it.each([
    ['429 {"type":"error","error":{"type":"rate_limit_error"}}', 'rate_limit'],
    [
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'overloaded',
    ],
    ['401 {"type":"error","error":{"type":"authentication_error"}}', 'authentication_failed'],
    ['insufficient_quota: billing hard limit reached', 'billing_error'],
    ['404 model_not_found: no such model', 'model_not_found'],
    ['400 {"type":"error","error":{"type":"invalid_request_error"}}', 'invalid_request'],
    ['500 Internal Server Error', 'server_error'],
    ['503 Service Unavailable', 'server_error'],
    ['socket closed unexpectedly', 'unknown'],
  ])('maps %s to %s', (error, expected) => {
    expect(stopFailureType(failed(error), error)).toBe(expected);
  });

  it('reads a truncated reply as max_output_tokens', () => {
    const message = { ...failed(''), stopReason: 'length' as const };
    expect(stopFailureType(message, 'length')).toBe('max_output_tokens');
  });
});
