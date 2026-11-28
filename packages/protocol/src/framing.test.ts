// Runs the shared frame codec cases in tests/contracts/framing/ against the TypeScript
// codec. crates/piarc-protocol/tests/framing.rs runs the same cases against the Rust one.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_FRAME_BYTES, FrameDecoder, MAX_NESTING, encodeFrame } from './framing.js';
import type { FrameResult } from './framing.js';

const casesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/contracts/framing',
);

interface Input {
  utf8?: string;
  hex?: string;
}

interface DecodeCase {
  name: string;
  category: string;
  maxFrameBytes?: number;
  steps: { input: Input; expect: unknown[] }[];
}

interface EncodeCase {
  name: string;
  value: unknown;
  expect: Input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asInput(value: unknown): Input {
  if (isRecord(value) && typeof value.utf8 === 'string') {
    return { utf8: value.utf8 };
  }
  if (isRecord(value) && typeof value.hex === 'string') {
    return { hex: value.hex };
  }
  throw new Error(`input needs utf8 or hex: ${JSON.stringify(value)}`);
}

function loadCases(file: string): Record<string, unknown>[] {
  const doc: unknown = JSON.parse(readFileSync(path.join(casesDir, file), 'utf8'));
  if (!isRecord(doc) || !Array.isArray(doc.cases) || !doc.cases.every(isRecord)) {
    throw new Error(`${file} has no cases array`);
  }
  return doc.cases;
}

function decodeCases(): DecodeCase[] {
  return loadCases('decode.json').map((c) => {
    if (typeof c.name !== 'string' || typeof c.category !== 'string' || !Array.isArray(c.steps)) {
      throw new Error(`malformed decode case: ${JSON.stringify(c)}`);
    }
    const steps = c.steps.map((step: unknown) => {
      if (!isRecord(step) || !Array.isArray(step.expect)) {
        throw new Error(`malformed step in ${String(c.name)}`);
      }
      return { input: asInput(step.input), expect: step.expect };
    });
    const decodeCase: DecodeCase = { name: c.name, category: c.category, steps };
    if (typeof c.maxFrameBytes === 'number') {
      decodeCase.maxFrameBytes = c.maxFrameBytes;
    }
    return decodeCase;
  });
}

function encodeCases(): EncodeCase[] {
  return loadCases('encode.json').map((c) => {
    if (typeof c.name !== 'string') {
      throw new Error(`malformed encode case: ${JSON.stringify(c)}`);
    }
    return { name: c.name, value: c.value, expect: asInput(c.expect) };
  });
}

function bytesOf(input: Input): Uint8Array {
  if (input.utf8 !== undefined) {
    return new TextEncoder().encode(input.utf8);
  }
  const hex = input.hex ?? '';
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

function summarize(frame: FrameResult): unknown {
  return frame.ok ? { value: frame.value } : { error: frame.error.kind };
}

const decode = decodeCases();

describe('FrameDecoder (shared cases)', () => {
  it('covers every required category', () => {
    const categories = new Set(decode.map((c) => c.category));
    for (const required of [
      'partial',
      'coalesced',
      'oversized',
      'invalidUtf8',
      'invalidJson',
      'lineSeparators',
    ]) {
      expect(categories, required).toContain(required);
    }
  });

  it.each(decode.map((c) => [c.name, c] as const))('%s', (_, testCase) => {
    const decoder = new FrameDecoder(testCase.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    testCase.steps.forEach((step, index) => {
      const actual = decoder.decode(bytesOf(step.input)).map(summarize);
      expect(actual, `step ${String(index)}`).toStrictEqual(step.expect);
    });
  });
});

describe('FrameDecoder', () => {
  it('reports structured, non-retryable errors', () => {
    const [frame] = new FrameDecoder(4).decode(new TextEncoder().encode('123456\n'));
    expect(frame).toMatchObject({ ok: false, error: { kind: 'frameTooLarge', retryable: false } });
  });

  it('accepts the maximum nesting and rejects one level more', () => {
    const nested = (depth: number) =>
      new TextEncoder().encode(`${'['.repeat(depth)}${']'.repeat(depth)}\n`);
    const decoder = new FrameDecoder();
    expect(decoder.decode(nested(MAX_NESTING))[0]?.ok).toBe(true);
    expect(decoder.decode(nested(MAX_NESTING + 1)).map(summarize)).toEqual([
      { error: 'parseError' },
    ]);
  });

  it('does not keep a reference to the caller buffer', () => {
    const decoder = new FrameDecoder();
    const chunk = new TextEncoder().encode('[1,');
    expect(decoder.decode(chunk)).toEqual([]);
    chunk.fill(0x20);
    expect(decoder.decode(new TextEncoder().encode('2]\n')).map(summarize)).toEqual([
      { value: [1, 2] },
    ]);
  });
});

describe('encodeFrame (shared cases)', () => {
  it.each(encodeCases().map((c) => [c.name, c] as const))('%s', (_, testCase) => {
    const frame = encodeFrame(testCase.value);
    expect(Array.from(frame)).toStrictEqual(Array.from(bytesOf(testCase.expect)));
    expect(frame.filter((b) => b === 0x0a)).toHaveLength(1);
    expect(frame.at(-1)).toBe(0x0a);
    expect(new FrameDecoder().decode(frame).map(summarize)).toStrictEqual([
      { value: testCase.value },
    ]);
  });

  it('throws for values JSON cannot represent', () => {
    expect(() => encodeFrame(undefined)).toThrow(TypeError);
  });

  it('refuses lone surrogates, which the Rust decoder rejects', () => {
    expect(() => encodeFrame({ text: 'a\ud800' })).toThrow(/lone surrogate/);
    expect(() => encodeFrame({ ['\udc00']: 1 })).toThrow(/lone surrogate/);
    expect(() => encodeFrame('\\\ud800')).toThrow(/lone surrogate/);
  });

  it('accepts surrogate pairs and text that merely looks like an escape', () => {
    for (const value of ['😀', '\\ud800', '\\\\ud800', 'x\\ud800']) {
      const frame = encodeFrame(value);
      expect(new FrameDecoder().decode(frame).map(summarize)).toEqual([{ value }]);
    }
  });
});
