import { expect, it } from 'vitest';

import { FAMILIES } from './families.js';
import { keyPageOf, keyPages } from './key-links.js';

it('links every quick-setup variant to an https page and nothing else', () => {
  for (const family of FAMILIES) {
    for (const variant of family.variants) {
      const page = keyPageOf(variant.id);
      expect(page, variant.id).toBeDefined();
      expect(new URL(page ?? '').protocol).toBe('https:');
    }
  }
  for (const [, page] of keyPages()) {
    const url = new URL(page);
    expect(url.protocol).toBe('https:');
    expect(url.username + url.password).toBe('');
  }
  expect(keyPageOf('custom')).toBeUndefined();
  expect(keyPageOf('toString')).toBeUndefined();
  expect(keyPageOf('openai-codex')).toBeUndefined();
});
