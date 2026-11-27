// ADR-0103: a message sent while a plan waits is a reply to it. The message steers first and the
// plan is declined `via: conversation` after it, with the comments; a message that did not go
// declines nothing.
import type { ApprovalRequest } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import type { answerRequest } from './answer.js';
import { planComments } from './plan-comments.js';
import { replyToPlan } from './plan-reply.js';

const PLAN = '1. Fix it';
const request = {
  requestId: 'plan-1',
  sessionId: 's',
  revision: 1,
  connectionEpoch: 1,
  tool: 'ExitPlanMode',
  kind: 'plan',
  plan: PLAN,
} as ApprovalRequest;

function recorder(outcome: 'applied' | 'handled' | Error) {
  const calls: string[] = [];
  const answers: unknown[] = [];
  const answer: typeof answerRequest = (_request, sent) => {
    calls.push('answer');
    answers.push(sent);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };
  const steer = (fails = false) => {
    calls.push('steer');
    return fails ? Promise.reject(new Error('busy')) : Promise.resolve();
  };
  return { calls, answers, answer, steer };
}

describe('replying to a plan', () => {
  it('steers the message, then declines the plan as a reply with the comments', async () => {
    planComments.add('plan-1', PLAN, 3, 9, 'Which bug?');
    const r = recorder('applied');
    const reply = await replyToPlan(request, () => r.steer(), r.answer);
    expect(reply).toEqual({ kind: 'answered', outcome: 'applied' });
    expect(r.calls).toEqual(['steer', 'answer']);
    expect(r.answers[0]).toEqual({
      decision: 'deny',
      via: 'conversation',
      comments: [{ start: 3, end: 9, quote: 'Fix it', text: 'Which bug?' }],
    });
    expect(planComments.get('plan-1')).toEqual([]);
  });

  it('declines nothing when the message did not go, and keeps the comments', async () => {
    planComments.add('plan-1', PLAN, 3, 9, 'Which bug?');
    const r = recorder('applied');
    const reply = await replyToPlan(request, () => r.steer(true), r.answer);
    expect(reply.kind).toBe('notSent');
    expect(r.calls).toEqual(['steer']);
    expect(planComments.get('plan-1')).toHaveLength(1);
    planComments.clear('plan-1');
  });

  it('reports a plan that was not sent back after the message went', async () => {
    const failed = recorder(new Error('stale'));
    expect((await replyToPlan(request, () => failed.steer(), failed.answer)).kind).toBe(
      'notAnswered',
    );
    const handled = recorder('handled');
    expect(await replyToPlan(request, () => handled.steer(), handled.answer)).toEqual({
      kind: 'answered',
      outcome: 'handled',
    });
  });
});
