import { describe, expect, it } from 'vitest';

import { devServerCsp, resolveDevServer } from '../dev-server.js';
import { PRODUCTION_CSP, securityHeaders } from './csp.js';

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values.join(' ')];
    }),
  );
}

describe('PRODUCTION_CSP', () => {
  const policy = directives(PRODUCTION_CSP);

  it('limits scripts, connections and images to the app origin', () => {
    expect(policy.get('default-src')).toBe("'self'");
    expect(policy.get('script-src')).toBe("'self'");
    expect(policy.get('connect-src')).toBe("'self'");
    expect(policy.get('img-src')).toBe("'self' data: piarc-document:");
    expect(policy.get('frame-src')).toBe('piarc-document:');
    expect(policy.get('media-src')).toBe('piarc-document:');
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'none'");
  });

  it('allows no inline code or eval', () => {
    expect(PRODUCTION_CSP).not.toMatch(/unsafe-|\*|https?:/);
  });

  it('is sent with nosniff', () => {
    expect(securityHeaders(PRODUCTION_CSP)).toEqual({
      'Content-Security-Policy': PRODUCTION_CSP,
      'X-Content-Type-Options': 'nosniff',
    });
  });
});

describe('devServerCsp', () => {
  it('relaxes only inline scripts, inline styles and the HMR socket', () => {
    const server = resolveDevServer('http://localhost:5173');
    expect(server).toEqual({ url: 'http://localhost:5173', origin: 'http://localhost:5173' });
    if (server === undefined) {
      return;
    }
    const dev = directives(devServerCsp(server));
    const production = directives(PRODUCTION_CSP);
    const changed = [...dev].filter(([name, value]) => production.get(name) !== value);
    expect(changed).toEqual([
      ['script-src', "'self' 'unsafe-inline'"],
      ['style-src', "'self' 'unsafe-inline'"],
      ['connect-src', "'self' ws://localhost:5173"],
    ]);
    expect([...dev.keys()]).toEqual([...production.keys()]);
  });

  it('is not used outside electron-forge start', () => {
    expect(resolveDevServer(undefined)).toBeUndefined();
    expect(resolveDevServer('')).toBeUndefined();
  });
});
