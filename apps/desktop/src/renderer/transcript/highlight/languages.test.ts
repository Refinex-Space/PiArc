import { describe, expect, it } from 'vitest';

import { HighlightClient, type HighlightWorkerPort } from './highlight-client.js';
import { languageId } from './languages.js';

// Names that exist on every plain object through its prototype. A fence's info string comes
// from model output or repository files, so any of them can arrive as a language name.
const PROTOTYPE_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
];

describe('languageId', () => {
  it('maps known names and aliases, ignoring case', () => {
    expect(languageId('ts')).toBe('typescript');
    expect(languageId('Rust')).toBe('rust');
    expect(languageId('zsh')).toBe('shellscript');
  });

  it('returns null for no language and for unknown names', () => {
    expect(languageId(null)).toBeNull();
    expect(languageId('brainfuck')).toBeNull();
  });

  it.each(PROTOTYPE_NAMES)('returns null for the prototype member name %s', (name) => {
    expect(languageId(name)).toBeNull();
    expect(languageId(name.toUpperCase())).toBeNull();
  });
});

describe('HighlightClient with a prototype member as the language', () => {
  it.each(PROTOTYPE_NAMES)('keeps %s as plain text and posts nothing', async (name) => {
    const posted: unknown[] = [];
    const worker: HighlightWorkerPort = {
      postMessage: (message) => posted.push(message),
      addEventListener: () => undefined,
    };
    const client = new HighlightClient(worker);
    expect(HighlightClient.supports(name, 'x')).toBe(false);
    await expect(client.highlight(name, 'x')).resolves.toBeNull();
    expect(posted).toEqual([]);
  });
});
