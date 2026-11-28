import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { MAX_BATCH, planBatches, ToolBatches } from './tool-batches.js';

const safe = (name: string): boolean => name === 'Read' || name === 'Grep';

function calls(spec: string): { id: string; name: string }[] {
  // "R12 W1 R2" → 12 reads, 1 write, 2 reads, numbered in order.
  let n = 0;
  return spec.split(' ').flatMap((part) => {
    const name = part.startsWith('R') ? 'Read' : 'Write';
    return Array.from({ length: Number(part.slice(1)) }, () => {
      n += 1;
      return { id: `c${String(n)}`, name };
    });
  });
}

/** A tool whose executions finish when the test says so, recording how many run at once. */
function gatedTool(): {
  tool: ToolDefinition;
  started: string[];
  finish: (id: string) => void;
  running: () => number;
} {
  const started: string[] = [];
  const finishers = new Map<string, () => void>();
  let running = 0;
  const tool = {
    name: 'Read',
    label: 'Read',
    description: 'test',
    parameters: { type: 'object', properties: {} },
    execute: async (id: string) => {
      started.push(id);
      running += 1;
      await new Promise<void>((resolve) => finishers.set(id, resolve));
      running -= 1;
      return { content: [{ type: 'text', text: id }], details: undefined };
    },
  } as unknown as ToolDefinition;
  return {
    tool,
    started,
    finish: (id) => finishers.get(id)?.(),
    running: () => running,
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('planBatches', () => {
  it('groups consecutive safe calls up to ten and runs every other call alone', () => {
    const batches = planBatches(calls('R12 W1 R2'), safe);
    expect(batches.map((batch) => batch.length)).toEqual([MAX_BATCH, 2, 1, 2]);
    expect(planBatches(calls('W1 W1 R3'), safe).map((b) => b.length)).toEqual([1, 1, 3]);
  });
});

describe('ToolBatches', () => {
  it('starts a batch only after every call before it is done', async () => {
    const batches = new ToolBatches(safe);
    const planned = calls('R12 W1 R2');
    batches.plan(planned);
    const gate = gatedTool();
    const tool = batches.wrap(gate.tool);
    const runs = planned.map((call) =>
      tool.execute(call.id, {}, undefined, undefined, undefined as never),
    );
    await tick();
    expect(gate.started).toEqual(planned.slice(0, 10).map((c) => c.id));
    for (const call of planned.slice(0, 10)) {
      gate.finish(call.id);
    }
    await tick();
    expect(gate.started.slice(10)).toEqual(['c11', 'c12']);
    gate.finish('c11');
    gate.finish('c12');
    await tick();
    expect(gate.started.slice(12)).toEqual(['c13']);
    expect(gate.running()).toBe(1);
    gate.finish('c13');
    await tick();
    expect(gate.started.slice(13)).toEqual(['c14', 'c15']);
    gate.finish('c14');
    gate.finish('c15');
    await Promise.all(runs);
    expect(batches.peak).toBe(MAX_BATCH);
  });

  it('counts calls Pi answered without running them, and lets waiting calls see the abort', async () => {
    const batches = new ToolBatches(safe);
    batches.plan(calls('W1 R1'));
    // c1 was refused before it ran: Pi reports its end.
    batches.done('c1');
    const gate = gatedTool();
    const tool = batches.wrap(gate.tool);
    const run = tool.execute('c2', {}, undefined, undefined, undefined as never);
    await tick();
    expect(gate.started).toEqual(['c2']);
    gate.finish('c2');
    await run;

    batches.plan(calls('W1 R1'));
    const controller = new AbortController();
    const waiting = tool.execute('c2', {}, controller.signal, undefined, undefined as never);
    controller.abort();
    await expect(waiting).rejects.toThrow('Operation aborted');
  });
});
