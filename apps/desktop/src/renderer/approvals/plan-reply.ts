// A message the user sends while a plan waits for review is a reply to the plan (ADR-0103). The
// message steers the turn first, so Pi holds it; then the card is declined `via: conversation`
// with the passages the user commented on. Pi delivers the steering message right after the
// refusal, before the model's next request: the model reads "not approved, the user wrote to
// you", then the message, and the transcript shows the message after the plan, not above the
// card. Comments go out with the refusal and are cleared once Core took it.
import type { ApprovalRequest } from '@piarc/protocol';

import { answerRequest, type AnswerOutcome } from './answer.js';
import { planComments } from './plan-comments.js';

/** Comments of plan `request` as the answer carries them. */
export function commentsOf(request: ApprovalRequest) {
  return planComments.get(request.requestId).map(({ start, end, quote, text }) => ({
    start,
    end,
    quote,
    text,
  }));
}

/**
 * How a reply went: the message did not go (`notSent`: the draft stays), or it went and the plan
 * was sent back (`answered`, with the ledger's outcome) or was not (`notAnswered`: the plan still
 * waits, the message is queued behind it).
 */
export type PlanReply =
  | { readonly kind: 'notSent'; readonly error: unknown }
  | { readonly kind: 'answered'; readonly outcome: AnswerOutcome }
  | { readonly kind: 'notAnswered'; readonly error: unknown };

/** Sends `steer` (the user's message as a steering input), then declines `request` as a reply in
 * the conversation. Nothing is declined when the message did not go. */
export async function replyToPlan(
  request: ApprovalRequest,
  steer: () => Promise<void>,
  answer: typeof answerRequest = answerRequest,
): Promise<PlanReply> {
  try {
    await steer();
  } catch (error) {
    return { kind: 'notSent', error };
  }
  const comments = commentsOf(request);
  try {
    const outcome = await answer(request, {
      decision: 'deny',
      via: 'conversation',
      ...(comments.length === 0 ? {} : { comments }),
    });
    if (outcome === 'applied') planComments.clear(request.requestId);
    return { kind: 'answered', outcome };
  } catch (error) {
    return { kind: 'notAnswered', error };
  }
}
