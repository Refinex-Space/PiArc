// Comments on diff lines in the Changes panel (T42, FR-RV-04): drafts of the renderer, kept in
// localStorage per session (architecture section 7.3: a convenience, losing them loses nothing
// of the session), sent to the agent together as one message.
//
// - A comment is bound to a side (`old` or `new`) and a line range of one file, with the lines'
//   text when it was written (`excerpt`). When the diff changes, `reanchor` finds the excerpt
//   again (same place first, then anywhere on that side of the file's hunks); a comment whose
//   lines are gone is `stale`: kept with its text, not sent.
// - `formatComments` is the one place the message to the agent is written: grouped by file, each
//   comment with its path, line range, side, the code it is about and the comment.
import type { ChangesFile } from '@piarc/protocol';

import type { KeyPlatform } from '../../shared/keybindings.js';
import { isImeComposing, type ImeKeyFields } from '../composer/ime-guard.js';

export type Side = 'old' | 'new';

export interface DiffComment {
  readonly id: string;
  /** The file's label as the panel shows it (relative to the workspace). */
  readonly path: string;
  readonly side: Side;
  /** First and last line of the range on that side, 1-based. */
  readonly start: number;
  readonly end: number;
  /** The range's lines when the comment was written. */
  readonly excerpt: readonly string[];
  readonly body: string;
  /** Its lines are no longer in the diff. */
  readonly stale?: boolean;
  /** The range of changes it was written on (ADR-0084): `session` when absent. */
  readonly scope?: string;
}

/** The scope a comment belongs to. */
export function scopeOfComment(comment: DiffComment): string {
  return comment.scope ?? 'session';
}

/** The numbered lines of one side of a file's diff. */
export function sideLines(file: ChangesFile, side: Side): Map<number, string> {
  const lines = new Map<number, string>();
  for (const hunk of file.diff?.hunks ?? []) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind !== 'added') {
        if (side === 'old') lines.set(oldLine, line.text);
        oldLine += 1;
      }
      if (line.kind !== 'removed') {
        if (side === 'new') lines.set(newLine, line.text);
        newLine += 1;
      }
    }
  }
  return lines;
}

function matchesAt(lines: Map<number, string>, start: number, excerpt: readonly string[]): boolean {
  return excerpt.every((text, i) => lines.get(start + i) === text);
}

/** `comment` without the stale mark. */
function placed(comment: DiffComment): DiffComment {
  return {
    id: comment.id,
    path: comment.path,
    side: comment.side,
    start: comment.start,
    end: comment.end,
    excerpt: comment.excerpt,
    body: comment.body,
    ...(comment.scope === undefined ? {} : { scope: comment.scope }),
  };
}

/** `comments` of `scope` placed on `files` as they are now; other scopes' stay as they are. */
export function reanchor(
  comments: readonly DiffComment[],
  files: readonly ChangesFile[],
  scope = 'session',
): DiffComment[] {
  return comments.map((comment) => {
    if (scopeOfComment(comment) !== scope) return comment;
    const file = files.find((f) => f.label === comment.path);
    if (file === undefined || comment.excerpt.length === 0) return { ...comment, stale: true };
    const lines = sideLines(file, comment.side);
    if (matchesAt(lines, comment.start, comment.excerpt)) return placed(comment);
    const starts = [...lines.keys()].sort((a, b) => a - b);
    const found = starts.find((start) => matchesAt(lines, start, comment.excerpt));
    if (found === undefined) return { ...comment, stale: true };
    return placed({ ...comment, start: found, end: found + comment.excerpt.length - 1 });
  });
}

/**
 * The message that sends `comments` (the ones still placed) to the agent; `heading` names the
 * range of changes they were written on (ADR-0084).
 */
export function formatComments(
  comments: readonly DiffComment[],
  heading = 'Review comments on the changes:',
): string {
  const live = comments.filter((c) => c.stale !== true);
  const byFile = new Map<string, DiffComment[]>();
  for (const c of live) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  const parts = [heading];
  for (const [path, list] of byFile) {
    parts.push('', `## ${path}`);
    for (const c of [...list].sort((a, b) => a.start - b.start)) {
      const range =
        c.start === c.end ? `Line ${String(c.start)}` : `Lines ${String(c.start)}-${String(c.end)}`;
      const side = c.side === 'new' ? 'new version' : 'old version';
      const fence = c.excerpt.some((l) => l.includes('```')) ? '````' : '```';
      parts.push('', `${range} (${side}):`, fence, ...c.excerpt, fence, c.body.trim());
    }
  }
  return parts.join('\n');
}

const KEY_PREFIX = 'piarc.diffComments.';

/** The session's saved drafts; nothing when storage is unavailable or the value is not ours. */
export function loadComments(sessionId: string): DiffComment[] {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + sessionId);
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(isComment);
  } catch {
    return [];
  }
}

/** Saves the session's drafts (best effort). */
export function saveComments(sessionId: string, comments: readonly DiffComment[]): void {
  try {
    if (comments.length === 0) window.localStorage.removeItem(KEY_PREFIX + sessionId);
    else window.localStorage.setItem(KEY_PREFIX + sessionId, JSON.stringify(comments));
  } catch {
    // Drafts are a convenience: without storage they last as long as the panel.
  }
}

function isComment(value: unknown): value is DiffComment {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  const line = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
  return (
    typeof c.id === 'string' &&
    typeof c.path === 'string' &&
    (c.side === 'old' || c.side === 'new') &&
    line(c.start) &&
    line(c.end) &&
    Array.isArray(c.excerpt) &&
    c.excerpt.every((l) => typeof l === 'string') &&
    typeof c.body === 'string' &&
    (c.scope === undefined || typeof c.scope === 'string')
  );
}

/** Mod+Enter, outside an input method composition: send every comment (as the composer's queue). */
export function isSendKey(
  event: ImeKeyFields & Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  platform: KeyPlatform,
): boolean {
  if (event.key !== 'Enter' || event.altKey || event.shiftKey || isImeComposing(event)) {
    return false;
  }
  return platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
