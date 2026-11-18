// T14-A01, A02: the projection's golden tests (L1). Each fixture in `agent-host/test/golden/`
// is a Pi event sequence with the registry's own steps (turn accepted, abort, queued input):
// recorded from the real Agent Host (`crates/piarc-testkit/tests/agent_host/golden.rs`) or, for
// what the mock provider and the current Harness Kit cannot produce yet, constructed with the
// same shapes. Replaying a fixture through the projector and the input queue must give the
// committed AHP notifications (`<name>.expected.json`, a file snapshot: `-u` rewrites it).
//
// The coverage test lists which rows of the projection table (architecture section 5.3), item
// types and item statuses the fixtures exercise, and fails when one is missing.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { plainInput } from './input.js';
import { isObject } from './items.js';
import { Projector, type ProjectionSink } from './projector.js';
import { InputQueue, type PiQueue } from './queue.js';

const GOLDEN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'golden',
);

interface Emitted {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

type Step =
  | { readonly kind: 'event'; readonly event: AgentSessionEvent }
  | { readonly kind: 'control'; readonly control: Record<string, unknown> };

function load(name: string): { source: string; steps: Step[] } {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(GOLDEN, `${name}.events.json`), 'utf8'),
  );
  if (!isObject(parsed) || !Array.isArray(parsed.steps) || typeof parsed.source !== 'string') {
    throw new Error(`${name}: not a golden fixture`);
  }
  const steps = parsed.steps.map((step: unknown): Step => {
    if (!isObject(step)) {
      throw new Error(`${name}: a step is not an object`);
    }
    if (typeof step.control === 'string') {
      return { kind: 'control', control: step };
    }
    if (typeof step.type !== 'string') {
      throw new Error(`${name}: a step has neither type nor control`);
    }
    // Recorded (or shaped like) Pi's own events; the projector checks every member it reads.
    return { kind: 'event', event: step as unknown as AgentSessionEvent };
  });
  return { source: parsed.source, steps };
}

/** Pi's steering list during a replay: whatever the recorded `queue_update` said last. */
class ReplayPi implements PiQueue {
  steering: string[] = [];

  steer(text: string): Promise<unknown> {
    this.steering.push(text);
    return Promise.resolve('queued');
  }

  clearQueue(): unknown {
    this.steering = [];
    return undefined;
  }

  getSteeringMessages(): readonly string[] {
    return this.steering;
  }
}

/** Replays `steps` the way the session registry handles live events (`#onEvent`). */
async function replay(steps: readonly Step[]): Promise<Emitted[]> {
  const out: Emitted[] = [];
  const sink: ProjectionSink = {
    event: (method, payload) => out.push({ method, payload }),
    delta: (method, _key, payload, delta) => out.push({ method, payload: { ...payload, delta } }),
    replaceable: (method, _key, payload) => out.push({ method, payload }),
  };
  const projector = new Projector(sink);
  const pi = new ReplayPi();
  const queue = new InputQueue('golden', pi, (items) => {
    sink.event('session/queueChanged', { items: [...items] });
  });
  for (const step of steps) {
    if (step.kind === 'control') {
      const { control } = step;
      const text = typeof control.text === 'string' ? control.text : '';
      switch (control.control) {
        case 'beginTurn':
          projector.beginTurn(String(control.turnId));
          break;
        case 'markAborting':
          projector.markAborting();
          queue.takeAll();
          break;
        case 'markDeclined':
          projector.markDeclined(String(control.toolCallId));
          break;
        case 'steer':
          await queue.steer(plainInput(text));
          break;
        case 'followUp':
          queue.followUp(plainInput(text));
          break;
        case 'takeFollowUp':
          queue.takeFollowUp();
          break;
        default:
          throw new Error(`unknown control ${String(control.control)}`);
      }
      continue;
    }
    const { event } = step;
    if (event.type === 'queue_update') {
      pi.steering = [...event.steering];
      queue.reconcile(event.steering);
    }
    projector.handle(event);
    if (event.type === 'agent_settled') {
      queue.settle();
    }
  }
  return out;
}

/** Ids the projector and the queue generate (random UUIDs) as `<id:n>` in order of appearance. */
function normalize(out: readonly Emitted[]): unknown {
  const ids = new Map<string, string>();
  const text = JSON.stringify(out).replaceAll(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    (uuid) => {
      let id = ids.get(uuid);
      if (id === undefined) {
        id = `<id:${String(ids.size + 1)}>`;
        ids.set(uuid, id);
      }
      return id;
    },
  );
  return JSON.parse(text) as unknown;
}

const FIXTURES = readdirSync(GOLDEN)
  .filter((file) => file.endsWith('.events.json'))
  .map((file) => file.slice(0, -'.events.json'.length))
  .sort();

describe('projection golden tests', () => {
  it.each(FIXTURES)('%s', async (name) => {
    const out = await replay(load(name).steps);
    await expect(`${JSON.stringify(normalize(out), null, 2)}\n`).toMatchFileSnapshot(
      path.join(GOLDEN, `${name}.expected.json`),
    );
  });

  it('marks tool calls by their own result: Grep without matches succeeds, a thrown error fails', async () => {
    const out = await replay(load('tools').steps);
    const completed = new Map(
      out
        .filter((e) => e.method === 'item/completed')
        .map((e) => e.payload.item)
        .filter(isObject)
        .map((item) => [String(item.itemId), item]),
    );
    expect(completed.get('toolu_grep')).toMatchObject({
      type: 'dynamicToolCall',
      tool: 'Grep',
      status: 'completed',
      output: 'No matches found',
    });
    expect(completed.get('toolu_missing')).toMatchObject({
      type: 'dynamicToolCall',
      tool: 'Read',
      status: 'failed',
    });
    expect(completed.get('toolu_bash')).toMatchObject({
      type: 'commandExecution',
      status: 'completed',
      command: 'echo 中文 output',
    });
  });

  it('covers every row of the projection table, every tool item type and every item status', async () => {
    const rows = new Map<string, string>([
      ['agent_start', 'turn/started'],
      ['agent_settled', 'turn/completed'],
      ['message_start(user)', 'item/started+completed userMessage'],
      ['message_update:text_delta', 'item/agentMessage/delta'],
      ['message_update:thinking_delta', 'item/reasoning/delta'],
      ['tool_execution_start', 'item/started'],
      ['tool_execution_update', 'item/updated'],
      ['tool_execution_end', 'item/completed'],
      ['compaction_start', 'item/started contextCompaction'],
      ['compaction_end', 'item/completed contextCompaction'],
      ['auto_retry_start', 'turn/retrying'],
      ['queue_update', 'session/queueChanged'],
      ['entry_appended(piarc.*)', 'harness/entry'],
    ]);
    const seenRows = new Set<string>();
    const types = new Set<string>();
    const statuses = new Set<string>();
    const matrix: string[] = [];
    for (const name of FIXTURES) {
      const { source, steps } = load(name);
      const fixtureRows = new Set<string>();
      for (const step of steps) {
        if (step.kind !== 'event') {
          continue;
        }
        const { event } = step;
        let row: string = event.type;
        if (event.type === 'message_update') {
          row = `message_update:${event.assistantMessageEvent.type}`;
        } else if (event.type === 'message_start' && event.message.role === 'user') {
          row = 'message_start(user)';
        } else if (event.type === 'entry_appended') {
          const custom = event.entry.type === 'custom' ? event.entry.customType : '';
          row = custom.startsWith('piarc.') ? 'entry_appended(piarc.*)' : 'entry_appended';
        }
        if (rows.has(row)) {
          fixtureRows.add(row);
          seenRows.add(row);
        }
      }
      const fixtureTypes = new Set<string>();
      const fixtureStatuses = new Set<string>();
      for (const emitted of await replay(steps)) {
        const { item } = emitted.payload;
        if (isObject(item)) {
          fixtureTypes.add(String(item.type));
          fixtureStatuses.add(String(item.status));
        }
      }
      fixtureTypes.forEach((type) => types.add(type));
      fixtureStatuses.forEach((status) => statuses.add(status));
      matrix.push(
        `${name} (${source}): rows [${[...fixtureRows].join(', ')}]; items [${[...fixtureTypes].join(', ')}]; statuses [${[...fixtureStatuses].join(', ')}]`,
      );
    }
    console.log(
      [
        'Projection coverage (architecture section 5.3):',
        ...matrix,
        ...[...rows].map(
          ([row, notification]) =>
            `  ${seenRows.has(row) ? 'covered' : 'MISSING'}  ${row} -> ${notification}`,
        ),
      ].join('\n'),
    );
    expect([...rows.keys()].filter((row) => !seenRows.has(row))).toEqual([]);
    for (const type of [
      'commandExecution',
      'fileChange',
      'mcpToolCall',
      'subagent',
      'webFetch',
      'dynamicToolCall',
      'userMessage',
      'agentMessage',
      'reasoning',
      'contextCompaction',
    ]) {
      expect(types, type).toContain(type);
    }
    for (const status of ['inProgress', 'completed', 'failed', 'declined', 'interrupted']) {
      expect(statuses, status).toContain(status);
    }
  });
});
