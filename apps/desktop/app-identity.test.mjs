import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { APP_IDENTIFIER } from './app-identity.mjs';

describe('APP_IDENTIFIER', () => {
  it('matches the Rust definition in piarc-core', () => {
    const source = readFileSync(
      path.join(import.meta.dirname, '..', '..', 'crates', 'piarc-core', 'src', 'identity.rs'),
      'utf8',
    );
    const match = /pub const APP_IDENTIFIER: &str = "([^"]+)";/.exec(source);
    expect(match?.[1]).toBe(APP_IDENTIFIER);
  });

  it('matches the main process copy (Windows AppUserModelID)', () => {
    const source = readFileSync(
      path.join(import.meta.dirname, 'src', 'main', 'app-identity.ts'),
      'utf8',
    );
    expect(/export const APP_IDENTIFIER = '([^']+)';/.exec(source)?.[1]).toBe(APP_IDENTIFIER);
  });
});
