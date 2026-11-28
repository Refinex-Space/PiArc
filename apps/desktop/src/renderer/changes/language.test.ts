import { describe, expect, it } from 'vitest';

import { languageOf } from './language.js';

describe('languageOf', () => {
  it('maps extensions and well-known names to highlight languages', () => {
    expect(languageOf('src/a 中文.ts')).toBe('ts');
    expect(languageOf('C:\\work\\lib.rs')).toBe('rs');
    expect(languageOf('scripts/build.mjs')).toBe('js');
    expect(languageOf('include/x.hpp')).toBe('cpp');
    expect(languageOf('Dockerfile')).toBe('dockerfile');
  });

  it('leaves unknown, extension-less and hidden files plain', () => {
    expect(languageOf('notes.md')).toBeNull();
    expect(languageOf('LICENSE')).toBeNull();
    expect(languageOf('.gitignore')).toBeNull();
    expect(languageOf('a.constructor')).toBeNull();
  });
});
