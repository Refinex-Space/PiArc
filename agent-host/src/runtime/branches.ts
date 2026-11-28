// Branches of a session's conversation (architecture section 6.9, T28, ADR-0044 rules 5–7).
//
// A turn starts where its first `piarc.input` record says (`from`: the leaf when the turn began,
// before any automatic compaction; older records without it start at their parent). Rewinding
// the conversation to before a turn moves Pi's leaf there and appends a `piarc.branch` record
// (Pi puts the leaf on the file's last entry when it opens a session, so the record keeps the
// position); summarizing from a turn appends Pi's `branch_summary` there instead. Nothing on the
// old branch is deleted.
//
// Branch points: turns whose start resolves to the same anchor are branches of each other. The
// anchor is the nearest entry above the start that the conversation shows (a user, assistant or
// tool result message, a custom message, a compaction); records, mode and model changes, system
// loadout messages and branch summaries are skipped, so a rewound branch whose first entry is a
// `piarc.branch` record, or a summary, sits next to the turns it replaced.
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { BranchPoint } from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import { INPUT_ENTRY } from './input.js';
import { contentText, isObject } from './items.js';

/** The custom entry that keeps a rewound or switched position. */
export const BRANCH_ENTRY = 'piarc.branch';

/** Longest preview of a branch's first message. */
const PREVIEW_CHARS = 80;

/** Where a turn starts. */
export interface TurnStart {
  readonly turnId: string;
  /** The turn's first `piarc.input` record. */
  readonly entryId: string;
  /** The leaf before the turn: the conversation to keep; `null` is the session's start. */
  readonly from: string | null;
}

/** The turn id and `from` of a user turn's input record (compactions are not branches). */
function inputOf(entry: SessionEntry): { turnId: string; from: string | null } | undefined {
  if (entry.type !== 'custom' || entry.customType !== INPUT_ENTRY || !isObject(entry.data)) {
    return undefined;
  }
  const { turnId, action, from } = entry.data;
  // Compactions and Monitor wakes (T32) are turns without a user message: not branch points.
  if (typeof turnId !== 'string' || action === 'compact' || action === 'wake') return undefined;
  const recorded = typeof from === 'string' || from === null ? from : undefined;
  return { turnId, from: recorded === undefined ? entry.parentId : recorded };
}

/** The first record of every user turn in `entries`, in their order. */
function turnStarts(entries: readonly SessionEntry[]): TurnStart[] {
  const seen = new Set<string>();
  const starts: TurnStart[] = [];
  for (const entry of entries) {
    const input = inputOf(entry);
    if (input === undefined || seen.has(input.turnId)) continue;
    seen.add(input.turnId);
    starts.push({ turnId: input.turnId, entryId: entry.id, from: input.from });
  }
  return starts;
}

/** Where turn `turnId` of the current branch `branch` starts. */
export function turnStart(branch: readonly SessionEntry[], turnId: string): TurnStart {
  const start = turnStarts(branch).find((s) => s.turnId === turnId);
  if (start === undefined) {
    throw new AhpError('invalidParams', `turn ${turnId} is not on the session's current branch`, {
      details: { turnId },
    });
  }
  return start;
}

/** What the user wrote in the first message after `entryId` on `branch`. */
export function turnText(branch: readonly SessionEntry[], entryId: string): string | undefined {
  const index = branch.findIndex((e) => e.id === entryId);
  for (const entry of branch.slice(index + 1)) {
    if (entry.type === 'message' && entry.message.role === 'user') {
      return contentText(entry.message.content)?.toWellFormed();
    }
  }
  return undefined;
}

/** Moves the leaf to `target` (`null`: before everything) and records the position. */
function moveLeaf(
  manager: SessionManager,
  target: string | null,
  data: Record<string, unknown>,
): void {
  const fromLeaf = manager.getLeafId();
  if (target === null) {
    manager.resetLeaf();
  } else {
    manager.branch(target);
  }
  manager.appendCustomEntry(BRANCH_ENTRY, { ...data, fromLeaf });
}

/** Rewinds the conversation to before turn `turnId`; returns what the user wrote in it. */
export function rewindToTurn(manager: SessionManager, turnId: string): string | undefined {
  const branch = manager.getBranch();
  const start = turnStart(branch, turnId);
  const text = turnText(branch, start.entryId);
  moveLeaf(manager, start.from, { turnId });
  return text;
}

/** The entries from turn `turnId` to the leaf, and where the turn starts. */
export function entriesFromTurn(
  manager: SessionManager,
  turnId: string,
): { start: TurnStart; entries: SessionEntry[] } {
  const branch = manager.getBranch();
  const start = turnStart(branch, turnId);
  const at = start.from === null ? 0 : branch.findIndex((e) => e.id === start.from) + 1;
  return { start, entries: branch.slice(at) };
}

/**
 * Summarizes turn `turnId` and everything after it with `summarize` and continues from where the
 * turn started, after the summary (Pi's `branch_summary`).
 */
export async function summarizeFromTurn(
  manager: SessionManager,
  turnId: string,
  summarize: (entries: SessionEntry[]) => Promise<{ summary: string; details: unknown }>,
): Promise<void> {
  const { start, entries } = entriesFromTurn(manager, turnId);
  const { summary, details } = await summarize(entries);
  manager.branchWithSummary(start.from, summary, details, true);
}

/**
 * The manager of a new session copying the current branch of the session file `file` up to
 * `entryId` (its leaf when absent), or up to where turn `beforeTurn` started: an empty session
 * for the first turn.
 */
export function forkedManager(
  sessionId: string,
  cwd: string,
  file: string | undefined,
  entryId: string | undefined,
  beforeTurn: string | undefined,
): SessionManager {
  if (file === undefined) {
    throw new AhpError('invalidParams', `session ${sessionId} has no saved conversation to fork`, {
      details: { sessionId },
    });
  }
  // A separate reader of the file: the open session's own manager keeps writing its file.
  const source = SessionManager.open(file);
  const start = beforeTurn === undefined ? undefined : turnStart(source.getBranch(), beforeTurn);
  if (start?.from === null) return SessionManager.create(cwd);
  const leaf = start?.from ?? entryId ?? source.getLeafId();
  if (leaf === null || source.getEntry(leaf) === undefined) {
    throw new AhpError('invalidParams', `session ${sessionId} has no entry ${String(entryId)}`, {
      details: { sessionId, entryId },
    });
  }
  const forked = source.createBranchedSession(leaf);
  if (forked === undefined) {
    throw new AhpError('internalError', `forking session ${sessionId} wrote no file`);
  }
  return SessionManager.open(forked);
}

/** Continues on the branch whose last entry is `entryId`. */
export function switchTo(manager: SessionManager, entryId: string): void {
  if (manager.getEntry(entryId) === undefined) {
    throw new AhpError('invalidParams', `the session has no entry ${entryId}`, {
      details: { entryId },
    });
  }
  moveLeaf(manager, entryId, { switched: true });
}

/** Whether the conversation shows `entry` (the anchors of branch points). */
function shown(entry: SessionEntry): boolean {
  switch (entry.type) {
    case 'message':
      return entry.message.role !== 'system';
    case 'custom_message':
    case 'compaction':
      return true;
    default:
      return false;
  }
}

/** The nearest shown entry at or above `id`; `null` at the start. */
function anchorOf(id: string | null, byId: ReadonlyMap<string, SessionEntry>): string | null {
  let current = id === null ? undefined : byId.get(id);
  while (current !== undefined && !shown(current)) {
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return current?.id ?? null;
}

/** The branch points on the current branch, oldest first. */
export function branchPoints(manager: SessionManager): BranchPoint[] {
  const entries = manager.getEntries();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const order = new Map(entries.map((e, i) => [e.id, i]));
  const children = new Map<string, SessionEntry[]>();
  for (const entry of entries) {
    if (entry.parentId === null) continue;
    const list = children.get(entry.parentId) ?? [];
    list.push(entry);
    children.set(entry.parentId, list);
  }
  const groups = new Map<string | null, TurnStart[]>();
  for (const start of turnStarts(entries)) {
    const anchor = anchorOf(start.from, byId);
    const group = groups.get(anchor) ?? [];
    group.push(start);
    groups.set(anchor, group);
  }
  const branch = manager.getBranch();
  const onPath = new Set(branch.map((e) => e.id));
  const leafAnchor = anchorOf(manager.getLeafId(), byId);
  const points: { at: number; point: BranchPoint }[] = [];
  for (const [anchor, group] of groups) {
    if (anchor !== null && !onPath.has(anchor)) continue;
    const index = group.findIndex((s) => onPath.has(s.entryId));
    // One turn here and the conversation goes through it: nothing to switch to.
    if (group.length < 2 && !(index === -1 && leafAnchor === anchor)) continue;
    // Another branch left this place and the current one went on without a turn here.
    if (index === -1 && leafAnchor !== anchor) continue;
    const options = group.map((s) => ({
      entryId: lastBelow(s.entryId, children, order),
      turnId: s.turnId,
      preview: preview(s.entryId, children),
    }));
    const current = group[index];
    points.push({
      at: anchor === null ? -1 : (order.get(anchor) ?? -1),
      point: {
        ...(current === undefined ? {} : { turnId: current.turnId, index }),
        options,
      },
    });
  }
  return points.sort((a, b) => a.at - b.at).map((p) => p.point);
}

/** The last written entry of the subtree below `id`: where switching to it continues. */
function lastBelow(
  id: string,
  children: ReadonlyMap<string, readonly SessionEntry[]>,
  order: ReadonlyMap<string, number>,
): string {
  let last = id;
  const stack = [id];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    if ((order.get(next) ?? -1) > (order.get(last) ?? -1)) last = next;
    for (const child of children.get(next) ?? []) stack.push(child.id);
  }
  return last;
}

/** The start of the first user message below `id`. */
function preview(id: string, children: ReadonlyMap<string, readonly SessionEntry[]>): string {
  const queue = [...(children.get(id) ?? [])];
  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined) break;
    if (entry.type === 'message' && entry.message.role === 'user') {
      const text = (contentText(entry.message.content) ?? '').replace(/\s+/g, ' ').trim();
      return text.slice(0, PREVIEW_CHARS).toWellFormed();
    }
    queue.push(...(children.get(entry.id) ?? []));
  }
  return '';
}

/** Whether turn `turnId`'s start is a branch point (other turns start at the same place). */
export function startsAtFork(manager: SessionManager, turnId: string): boolean {
  return branchPoints(manager).some((p) => p.turnId === turnId);
}
