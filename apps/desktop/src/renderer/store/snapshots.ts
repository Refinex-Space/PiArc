// Core's entity snapshots (architecture section 7.6): the workspace list on `core/workspaces`
// and the session list on `core/sessions`, each with a `revision`. They arrive over the event
// channel as JSON, so every field is checked before the store uses it.

import { isPermissionMode, type ApprovalRequest } from '@piarc/protocol';
import type { PermissionMode } from '../../shared/ipc.js';
import { isApproval } from './approvals.js';
const NO_APPROVALS: readonly ApprovalRequest[] = [];

/** Where a workspace's Agent Host stands (`piarc_core::sessions::HostState`). */
export type HostState =
  'closed' | 'starting' | 'ready' | 'reclaimed' | 'restarting' | 'unavailable';

export interface WorkspaceEntry {
  readonly path: string;
  readonly displayName: string;
  readonly mainCheckout: string;
  readonly open: boolean;
  readonly host: HostState;
  readonly lastOpenedAt: number;
}

export type SessionStatus = 'idle' | 'running' | 'error';

export interface SessionEntry {
  readonly id: string;
  readonly workspace: string | undefined;
  readonly cwd: string | undefined;
  readonly title: string | undefined;
  readonly status: SessionStatus;
  readonly unread: boolean;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly open: boolean;
  readonly model: string | undefined;
  readonly messageCount: number;
  readonly createdAt: number | undefined;
  readonly updatedAt: number | undefined;
  readonly error: string | undefined;
  /** Approval requests waiting for the user (Core reports them from T20 on). */
  readonly approvals: readonly ApprovalRequest[];
  readonly permissionMode: PermissionMode;
  readonly pendingApprovals: number;
  /**
   * Its worktree (T35): name, directory and branch; flat values, so an unchanged entry stays
   * the same object across snapshots.
   */
  readonly worktreeName: string | undefined;
  readonly worktreePath: string | undefined;
  readonly worktreeBranch: string | undefined;
  /** The cleanup found uncommitted changes in its worktree and waits for the user. */
  readonly worktreeConfirmCleanup: boolean;
  /** Its worktree was removed (its branch stays). */
  readonly worktreeRemoved: boolean;
}

export interface Snapshot<T> {
  readonly revision: number;
  readonly entries: readonly T[];
}

const HOST_STATES: readonly HostState[] = [
  'closed',
  'starting',
  'ready',
  'reclaimed',
  'restarting',
  'unavailable',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function revisionOf(value: Record<string, unknown>): number | undefined {
  const { revision } = value;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : undefined;
}

function workspaceEntry(value: unknown): WorkspaceEntry | undefined {
  if (!isRecord(value) || typeof value.path !== 'string') {
    return undefined;
  }
  const host = HOST_STATES.find((state) => state === value.host) ?? 'closed';
  return {
    path: value.path,
    displayName: optionalString(value.displayName) ?? value.path,
    mainCheckout: optionalString(value.mainCheckout) ?? value.path,
    open: value.open === true,
    host,
    lastOpenedAt: optionalNumber(value.lastOpenedAt) ?? 0,
  };
}

function sessionEntry(value: unknown): SessionEntry | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return undefined;
  }
  const status: SessionStatus =
    value.status === 'running' || value.status === 'error' ? value.status : 'idle';
  return {
    id: value.id,
    workspace: optionalString(value.workspace),
    cwd: optionalString(value.cwd),
    title: optionalString(value.title),
    status,
    unread: value.unread === true,
    pinned: value.pinned === true,
    archived: value.archived === true,
    open: value.open === true,
    model: optionalString(value.model),
    messageCount: optionalNumber(value.messageCount) ?? 0,
    createdAt: optionalNumber(value.createdAt),
    updatedAt: optionalNumber(value.updatedAt),
    error: optionalString(value.error),
    permissionMode: isPermissionMode(value.permissionMode) ? value.permissionMode : 'default',
    approvals:
      Array.isArray(value.approvals) && value.approvals.length > 0
        ? value.approvals.filter((a: unknown): a is ApprovalRequest =>
            isApproval(a, String(value.id)),
          )
        : NO_APPROVALS,
    pendingApprovals: optionalNumber(value.pendingApprovals) ?? 0,
    ...worktreeFields(value.worktree),
  };
}

function worktreeFields(value: unknown) {
  const tree = isRecord(value) ? value : {};
  return {
    worktreeName: optionalString(tree.name),
    worktreePath: optionalString(tree.path),
    worktreeBranch: optionalString(tree.branch),
    worktreeConfirmCleanup: tree.confirmCleanup === true,
    worktreeRemoved: tree.removed === true,
  };
}

function parse<T>(
  value: unknown,
  key: string,
  entry: (value: unknown) => T | undefined,
): Snapshot<T> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const revision = revisionOf(value);
  const list = value[key];
  if (revision === undefined || !Array.isArray(list)) {
    return undefined;
  }
  const entries: T[] = [];
  for (const item of list) {
    const parsed = entry(item);
    if (parsed !== undefined) {
      entries.push(parsed);
    }
  }
  return { revision, entries };
}

/** A `core/workspaces` event, or `undefined` when it is malformed. */
export function parseWorkspaces(value: unknown): Snapshot<WorkspaceEntry> | undefined {
  return parse(value, 'workspaces', workspaceEntry);
}

/** A `core/sessions` event, or `undefined` when it is malformed. */
export function parseSessions(value: unknown): Snapshot<SessionEntry> | undefined {
  return parse(value, 'sessions', sessionEntry);
}

/** Whether two entries show the same thing (the store keeps the old object when they do). */
export function sameEntry<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
