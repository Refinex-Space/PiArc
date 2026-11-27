import { describe, expect, it } from 'vitest';

import type { BrowserRunAnswer } from '@piarc/protocol';

import { AgentBridge, parseClientEvent } from './agent-bridge.js';
import type { AgentRun } from './script-host.js';

const encoder = new TextEncoder();
const batch = (events: unknown) => ({
  route: 'core/browser',
  seq: 1,
  payload: encoder.encode(JSON.stringify(events)),
});

const RUN = {
  type: 'run',
  runId: 'run-1-call',
  sessionId: 'child',
  mainSessionId: 'main',
  agentType: 'general-purpose',
  workspace: '/w',
  toolCallId: 'call',
  script: 'console.log(1)',
  timeoutMs: 5000,
};

function fixture(answer: BrowserRunAnswer | undefined | Error) {
  const answered: { runId: string; json: string }[] = [];
  const cancelled: string[] = [];
  const runs: AgentRun[] = [];
  let attached = false;
  const bridge = new AgentBridge(
    {
      attachBrowserClient: () => {
        attached = true;
      },
      answerBrowserRun: (runId, json) => {
        answered.push({ runId, json });
        return true;
      },
    },
    {
      run: (run) => {
        runs.push(run);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      cancel: (runId) => cancelled.push(runId),
    },
  );
  return { bridge, answered, cancelled, runs, attached: () => attached };
}

describe('parseClientEvent', () => {
  it('reads runs for the main session and cancels', () => {
    expect(parseClientEvent(RUN)).toEqual({
      type: 'run',
      run: {
        runId: 'run-1-call',
        sessionId: 'main',
        workspace: '/w',
        callSessionId: 'child',
        toolCallId: 'call',
        agentType: 'general-purpose',
        script: 'console.log(1)',
        timeoutMs: 5000,
      },
    });
    expect(parseClientEvent({ type: 'cancel', runId: 'r' })).toEqual({
      type: 'cancel',
      runId: 'r',
    });
  });

  it.each([
    [{ ...RUN, script: 1 }],
    [{ ...RUN, timeoutMs: -1 }],
    [{ ...RUN, mainSessionId: undefined }],
    [{ type: 'other', runId: 'r' }],
    [null],
  ])('rejects %j', (value) => {
    expect(parseClientEvent(value)).toBeUndefined();
  });
});

describe('AgentBridge', () => {
  it('attaches, runs and answers Core', async () => {
    const f = fixture({ output: 'done' });
    f.bridge.attach();
    expect(f.attached()).toBe(true);
    f.bridge.deliver(batch([RUN]));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.runs[0]?.sessionId).toBe('main');
    expect(f.answered).toEqual([{ runId: 'run-1-call', json: JSON.stringify({ output: 'done' }) }]);
  });

  it('answers a host failure as a script error', async () => {
    const f = fixture(new Error('no host'));
    f.bridge.deliver(batch([RUN]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answer = JSON.parse(f.answered[0]?.json ?? '{}') as BrowserRunAnswer;
    expect(answer.error?.code).toBe('PIARC_RUN_ENDED');
    expect(answer.error?.message).toContain('no host');
  });

  it('does not answer a cancelled run and passes cancels on', async () => {
    const f = fixture(undefined);
    f.bridge.deliver(batch([RUN, { type: 'cancel', runId: 'run-1-call' }]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.cancelled).toEqual(['run-1-call']);
    expect(f.answered).toEqual([]);
  });

  it('ignores batches that are not JSON arrays', () => {
    const f = fixture({ output: '' });
    f.bridge.deliver({ route: 'core/browser', seq: 1, payload: encoder.encode('{') });
    f.bridge.deliver(batch({ type: 'run' }));
    expect(f.runs).toEqual([]);
  });
});
