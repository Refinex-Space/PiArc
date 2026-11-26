// AI review results (ADR-0087, design addendum V1): kept in memory per session and scope, marked
// "may be outdated" once the scope's changes differ from what was reviewed, with findings the
// user dismissed left out. `formatFindings` is the only place that writes the message handed to
// the agent ("Ask the agent to fix").
import type { DiffHunk } from '@piarc/protocol';
import { useCallback, useSyncExternalStore } from 'react';

import type { FileChange, Finding, Review } from './protocol.js';

/** A review of one scope. */
export interface ReviewRecord {
  readonly review: Review;
  /** `findingId`s the user dismissed. */
  readonly dismissed: ReadonlySet<string>;
  /** The scope's changes when the review was asked for (`changesKeyOf`). */
  readonly changesKey: string;
}

export interface ReviewState {
  /** The review being written: its operation id and scope key. */
  readonly running?: { readonly opId: string; readonly scopeKey: string } | undefined;
  /** Reviews by scope key (`scopeKey` of the scope choice). */
  readonly records: ReadonlyMap<string, ReviewRecord>;
}

const EMPTY: ReviewState = { records: new Map() };
const states = new Map<string, ReviewState>();
const listeners = new Map<string, Set<() => void>>();

function stateOf(sessionId: string): ReviewState {
  return states.get(sessionId) ?? EMPTY;
}

function setState(sessionId: string, next: ReviewState): void {
  states.set(sessionId, next);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

/** A finding's identity within a review. */
export function findingId(finding: Finding): string {
  return `${finding.path}\u0000${String(finding.line)}\u0000${finding.title}`;
}

/** FNV-1a over `text`, as 8 hex digits: enough to tell two diffs apart, not a digest. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * What the scope's changes are, to tell whether a review still describes them: each file's
 * status and counts, and its hunks' ranges and lines (an edit that keeps the counts still
 * counts).
 */
export function changesKeyOf(files: readonly FileChange[]): string {
  return files
    .map((f) => {
      const hunks = (f.diff?.hunks ?? [])
        .map(
          (h) =>
            `${String(h.newStart)},${String(h.newLines)}:${fnv(h.lines.map((l) => l.kind + l.text).join('\n'))}`,
        )
        .join(';');
      return `${f.path}:${f.status}:${String(f.added ?? '')}:${String(f.removed ?? '')}:${hunks}`;
    })
    .join('\n');
}

/** The findings the user has not dismissed, in file and line order. */
export function shownFindings(record: ReviewRecord | undefined): Finding[] {
  if (record === undefined) return [];
  return record.review.findings
    .filter((f) => !record.dismissed.has(findingId(f)))
    .sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}

/** The lines of the new version a file's hunks show (context and added lines). */
export function shownLines(hunks: readonly DiffHunk[]): ReadonlySet<number> {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    let line = hunk.newStart;
    for (const l of hunk.lines) {
      if (l.kind === 'removed') continue;
      lines.add(line);
      line += 1;
    }
  }
  return lines;
}

/**
 * The message that asks the agent to fix `findings` (English, like the comments' message: the
 * model reads it). `heading` names the scope.
 */
export function formatFindings(
  findings: readonly Finding[],
  heading = 'Code review findings on the changes:',
): string {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f]);
  const parts = [
    heading,
    'Fix the findings that hold up. For any you leave as they are, say which and why.',
  ];
  for (const [path, list] of byFile) {
    parts.push('', `## ${path}`);
    for (const f of [...list].sort((a, b) => a.line - b.line)) {
      parts.push(`- Line ${String(f.line)} (${f.severity}): ${f.title}`);
      const body = f.body.trim();
      if (body !== '') parts.push(...body.split('\n').map((l) => `  ${l}`));
    }
  }
  return parts.join('\n');
}

/** Starts (with an operation id) or ends (`undefined`) the session's running review. */
export function setReviewRunning(
  sessionId: string,
  running: { readonly opId: string; readonly scopeKey: string } | undefined,
): void {
  setState(sessionId, { ...stateOf(sessionId), running });
}

/** Keeps the review of `scopeKey`, replacing an earlier one. */
export function storeReview(
  sessionId: string,
  scopeKey: string,
  review: Review,
  changesKey: string,
): void {
  const records = new Map(stateOf(sessionId).records);
  records.set(scopeKey, { review, dismissed: new Set(), changesKey });
  setState(sessionId, { ...stateOf(sessionId), records });
}

/** Leaves one finding out of the review of `scopeKey`. */
export function dismissFinding(sessionId: string, scopeKey: string, id: string): void {
  const record = stateOf(sessionId).records.get(scopeKey);
  if (record === undefined) return;
  const records = new Map(stateOf(sessionId).records);
  records.set(scopeKey, { ...record, dismissed: new Set(record.dismissed).add(id) });
  setState(sessionId, { ...stateOf(sessionId), records });
}

/** Forgets the review of `scopeKey`. */
export function clearReview(sessionId: string, scopeKey: string): void {
  const records = new Map(stateOf(sessionId).records);
  records.delete(scopeKey);
  setState(sessionId, { ...stateOf(sessionId), records });
}

/** The session's reviews and the one being written. */
export function useReviews(sessionId: string): ReviewState {
  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(sessionId);
      if (set === undefined) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    [sessionId],
  );
  return useSyncExternalStore(subscribe, () => stateOf(sessionId));
}
