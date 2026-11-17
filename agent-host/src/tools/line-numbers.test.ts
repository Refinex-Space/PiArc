import { describe, expect, it } from 'vitest';

import { LineNumberer, numberedChunks, numberedText } from './line-numbers.js';

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of chunks) {
    parts.push(Buffer.from(chunk).toString('utf8'));
  }
  return parts.join('');
}

async function* pieces(...texts: string[]): AsyncGenerator<Uint8Array> {
  for (const text of texts) {
    yield Buffer.from(text, 'utf8');
  }
  await Promise.resolve();
}

describe('line numbers', () => {
  it('number every line like cat -n, empty lines included, not the remainder after the last break', () => {
    expect(numberedText('a\n\nb\n')).toBe('     1\ta\n     2\t\n     3\tb\n');
    expect(numberedText('a\nb')).toBe('     1\ta\n     2\tb');
    expect(numberedText('')).toBe('');
    expect(numberedText('x\r\ny\r\n')).toBe('     1\tx\r\n     2\ty\r\n');
  });

  it('keep counting across pieces that split lines anywhere', async () => {
    const text = await collect(numberedChunks(pieces('one\ntw', 'o\n', '\nfo', 'ur')));
    expect(text).toBe('     1\tone\n     2\ttwo\n     3\t\n     4\tfour');
  });

  it('drop a byte order mark at the start of the file only', () => {
    const numberer = new LineNumberer();
    expect(numberer.push('﻿first\n')).toBe('     1\tfirst\n');
    expect(numberer.push('﻿second')).toBe('     2\t﻿second');
  });

  it('widen past six digits without losing the tab', () => {
    const numberer = new LineNumberer();
    numberer.push('\n'.repeat(999_999));
    expect(numberer.push('last')).toBe('1000000\tlast');
  });
});
