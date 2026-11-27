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
 * Sends `steer` (the user's message as a steering input), then declines `request` as a reply in
 * the conversation. A failed steer leaves the plan waiting; the caller reports it.
 */
export async function replyToPlan(
  request: ApprovalRequest,
  steer: () => Promise<void>,
): Promise<AnswerOutcome> {
  await steer();
  const comments = commentsOf(request);
  const outcome = await answerRequest(request, {
    decision: 'deny',
    via: 'conversation',
    ...(comments.length === 0 ? {} : { comments }),
  });
  if (outcome === 'applied') planComments.clear(request.requestId);
  return outcome;
}
