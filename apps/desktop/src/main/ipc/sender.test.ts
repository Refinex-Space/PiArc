import { describe, expect, it } from 'vitest';

import { APP_ORIGIN } from '../app-scheme.js';
import { isTrustedSender } from './sender.js';

const trusted = [APP_ORIGIN];

describe('isTrustedSender', () => {
  it('accepts a frame whose origin is the app origin', () => {
    expect(isTrustedSender({ origin: 'app://piarc' }, trusted)).toBe(true);
  });

  it('rejects a missing frame', () => {
    expect(isTrustedSender(null, trusted)).toBe(false);
    expect(isTrustedSender(undefined, trusted)).toBe(false);
  });

  it('rejects frames of other origins', () => {
    for (const origin of [
      'https://example.com',
      'http://localhost:5173',
      'file://',
      'null',
      '',
      'app://other',
      'APP://PIARC',
    ]) {
      expect(isTrustedSender({ origin }, trusted), origin).toBe(false);
    }
  });

  it('rejects origins that only start with the app origin', () => {
    for (const origin of [
      'app://piarcx',
      'app://piarc.evil.com',
      'app://piarc:8080',
      'app://piarc/',
    ]) {
      expect(isTrustedSender({ origin }, trusted), origin).toBe(false);
    }
  });

  it('accepts every listed origin and nothing else', () => {
    const withDevServer = [APP_ORIGIN, 'http://localhost:5173'];
    expect(isTrustedSender({ origin: 'http://localhost:5173' }, withDevServer)).toBe(true);
    expect(isTrustedSender({ origin: 'http://localhost:5174' }, withDevServer)).toBe(false);
  });
});
