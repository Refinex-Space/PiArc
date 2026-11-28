// T41-A10: the shared cost vectors (`tests/usage/cost-vectors.json`) are what pi-ai's
// `calculateCost` gives today; Core's integer arithmetic is checked against the same file
// (`crates/piarc-core/src/usage_tests.rs`), so a change in pi-ai's rules fails here first.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { calculateCost, type Model, type Api, type Usage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

interface Vector {
  readonly price: string;
  readonly usage: Record<string, number>;
  readonly total: number;
}

function load(): { prices: Record<string, Model<Api>['cost']>; vectors: Vector[] } {
  const url = new URL('../../../tests/usage/cost-vectors.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('prices' in parsed) ||
    !('vectors' in parsed)
  ) {
    throw new Error('cost-vectors.json has no prices or vectors');
  }
  return parsed as { prices: Record<string, Model<Api>['cost']>; vectors: Vector[] };
}

describe('usage cost vectors', () => {
  it('are calculateCost results', () => {
    const { prices, vectors } = load();
    expect(vectors.length).toBeGreaterThanOrEqual(20);
    for (const vector of vectors) {
      const cost = prices[vector.price];
      if (cost === undefined) throw new Error(`no price ${vector.price}`);
      const usage: Usage = {
        input: vector.usage.input ?? 0,
        output: vector.usage.output ?? 0,
        cacheRead: vector.usage.cacheRead ?? 0,
        cacheWrite: vector.usage.cacheWrite ?? 0,
        ...(vector.usage.cacheWrite1h === undefined
          ? {}
          : { cacheWrite1h: vector.usage.cacheWrite1h }),
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const model = { cost } as Model<Api>;
      expect(calculateCost(model, usage).total).toBe(vector.total);
    }
  });
});
