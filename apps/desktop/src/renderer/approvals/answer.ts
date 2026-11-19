// Answering a card of Core's approval ledger: the answer names the card's revision and Agent
// Host connection; a stale or already handled card asks Core for fresh snapshots.
import type { ApprovalAnswer, ApprovalRequest } from '@piarc/protocol';

/** How an answer went: applied, cancelled at the native confirmation, or no longer current. */
export type AnswerOutcome = 'applied' | 'cancelled' | 'handled';

export async function answerRequest(
  request: ApprovalRequest,
  answer: Omit<ApprovalAnswer, 'sessionId' | 'requestId' | 'revision' | 'connectionEpoch'>,
): Promise<AnswerOutcome> {
  const { sessionId, requestId, revision, connectionEpoch } = request;
  const raw = await window.piarc.answerApproval({
    sessionId,
    requestId,
    revision,
    connectionEpoch,
    ...answer,
  });
  const value: unknown = JSON.parse(raw);
  const status = value && typeof value === 'object' && 'status' in value ? value.status : undefined;
  if (status === 'applied') return 'applied';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'stale' || status === 'alreadyHandled') {
    await window.piarc.resendSnapshots();
    return 'handled';
  }
  throw new Error('Invalid approval response');
}
