// The approval ledger arrives inside session snapshots. Records are immutable at a revision.
import type { ApprovalRequest, DiffHunk } from '@piarc/protocol';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hunk(value: unknown): value is DiffHunk {
  if (
    !record(value) ||
    !integer(value.oldStart) ||
    !integer(value.oldLines) ||
    !integer(value.newStart) ||
    !integer(value.newLines) ||
    !Array.isArray(value.lines)
  )
    return false;
  return value.lines.every(
    (line: unknown) =>
      record(line) &&
      typeof line.text === 'string' &&
      (line.kind === 'added' || line.kind === 'removed' || line.kind === 'context'),
  );
}

/** A subagent's card (T31) in its main session's entry: it is answered under the subagent's
 * own session id, and names the subagent. */
function subagentOrigin(value: Record<string, unknown>): boolean {
  const origin = value.subagent;
  return (
    record(origin) &&
    origin.sessionId === value.sessionId &&
    typeof origin.parentSessionId === 'string' &&
    typeof origin.agentType === 'string' &&
    (origin.description == null || typeof origin.description === 'string')
  );
}

export function isApproval(value: unknown, sessionId: string): value is ApprovalRequest {
  if (
    !record(value) ||
    (value.sessionId !== sessionId && !subagentOrigin(value)) ||
    typeof value.requestId !== 'string' ||
    !integer(value.revision) ||
    !integer(value.connectionEpoch) ||
    typeof value.tool !== 'string'
  )
    return false;
  if (
    !['command', 'fileChange', 'permissionExpansion', 'question', 'plan'].some(
      (kind) => kind === value.kind,
    )
  )
    return false;
  if (value.kind === 'plan' && typeof value.plan !== 'string') return false;
  if (value.kind === 'question' && !questionsOf(value.questions)) return false;
  if (
    !['command', 'cwd', 'path', 'rule', 'directory'].every(
      (key) => value[key] == null || typeof value[key] === 'string',
    )
  )
    return false;
  if (value.protectedPath != null && typeof value.protectedPath !== 'boolean') return false;
  const diff = value.diff;
  return (
    diff == null ||
    (record(diff) &&
      typeof diff.unified === 'string' &&
      typeof diff.path === 'string' &&
      integer(diff.added) &&
      integer(diff.removed) &&
      Array.isArray(diff.hunks) &&
      diff.hunks.every(hunk))
  );
}

/** A question card's questions (T26): text, 2–4 labelled options, flags. */
function questionsOf(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (q: unknown) =>
        record(q) &&
        typeof q.question === 'string' &&
        (q.header == null || typeof q.header === 'string') &&
        (q.multiSelect == null || typeof q.multiSelect === 'boolean') &&
        Array.isArray(q.options) &&
        q.options.length > 0 &&
        q.options.every(
          (o: unknown) =>
            record(o) &&
            typeof o.label === 'string' &&
            (o.description == null || typeof o.description === 'string') &&
            (o.default == null || typeof o.default === 'boolean'),
        ),
    )
  );
}

export function sameRequest(a: ApprovalRequest, b: ApprovalRequest): boolean {
  return (
    a.requestId === b.requestId &&
    a.revision === b.revision &&
    a.connectionEpoch === b.connectionEpoch
  );
}
