// The Git panel's view of Core's `gitRequest` answers (ADR-0084, ADR-0085): the renderer's own
// shapes (absent instead of null), checked field by field before use, and the one call that
// sends a request and parses `{ result }` or `{ failure }`.
import type { FileDiff } from '@piarc/protocol';

import { fileDiffOf } from '../../store/changes.js';

export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'untracked'
  | 'conflicted';

export type RepoState =
  | { readonly kind: 'clean' }
  | { readonly kind: 'merging'; readonly source?: string | undefined }
  | {
      readonly kind: 'rebasing';
      readonly branch?: string | undefined;
      readonly onto?: string | undefined;
      readonly step?: number | undefined;
      readonly total?: number | undefined;
    }
  | { readonly kind: 'cherryPicking'; readonly commit?: string | undefined }
  | { readonly kind: 'reverting'; readonly commit?: string | undefined }
  | undefined;

export interface GitBase {
  readonly name: string;
  readonly reference: string;
  readonly mergeBase?: string | undefined;
}

export interface Repository {
  readonly root: string;
  readonly branch?: string | undefined;
  readonly head?: string | undefined;
  readonly detached: boolean;
  readonly upstream?: string | undefined;
  readonly ahead: number;
  readonly behind: number;
  readonly state: RepoState;
  readonly remotes: readonly string[];
  readonly base?: GitBase | undefined;
  readonly writable: boolean;
  readonly protected: boolean;
  readonly added: number;
  readonly removed: number;
}

export interface StatusFile {
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly staged?: FileStatus | undefined;
  readonly unstaged?: FileStatus | undefined;
  readonly conflict?: string | undefined;
  readonly submodule: boolean;
  readonly added?: number | undefined;
  readonly removed?: number | undefined;
}

export interface Status {
  readonly repository: Repository;
  readonly files: readonly StatusFile[];
  readonly truncated: boolean;
  readonly fingerprint: string;
}

export type Scope =
  | { readonly kind: 'branch'; readonly base?: string | undefined }
  | { readonly kind: 'uncommitted' }
  | { readonly kind: 'commit'; readonly sha: string };

export interface FileChange {
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly status: FileStatus;
  readonly added?: number | undefined;
  readonly removed?: number | undefined;
  readonly binary: boolean;
  readonly oldMode?: string | undefined;
  readonly newMode?: string | undefined;
  readonly submodule: boolean;
  readonly diff?: FileDiff | undefined;
}

export interface Changes {
  readonly scope: Scope;
  readonly base?: GitBase | undefined;
  readonly files: readonly FileChange[];
  readonly added: number;
  readonly removed: number;
  readonly withheld: boolean;
  readonly truncated: boolean;
}

export interface CommitRow {
  readonly sha: string;
  readonly short: string;
  readonly subject: string;
  readonly author: string;
  readonly time: number;
}

export interface Commits {
  readonly base?: GitBase | undefined;
  readonly commits: readonly CommitRow[];
  readonly total: number;
}

export interface LocalBranch {
  readonly name: string;
  readonly oid: string;
  readonly upstream?: string | undefined;
  readonly ahead?: number | undefined;
  readonly behind?: number | undefined;
  readonly gone: boolean;
  readonly current: boolean;
  readonly worktree?: string | undefined;
  readonly time: number;
}

export interface RemoteBranch {
  readonly remote: string;
  readonly name: string;
  readonly oid: string;
  readonly time: number;
}

export interface Branches {
  readonly local: readonly LocalBranch[];
  readonly remote: readonly RemoteBranch[];
  readonly recent: readonly string[];
  readonly remotes: readonly string[];
}

export interface FileStages {
  readonly path: string;
  readonly staged?: FileDiff | undefined;
  readonly unstaged?: FileDiff | undefined;
  readonly stagedHashes: readonly string[];
  readonly hunkHashes: readonly string[];
  readonly worktreeHash: string;
  readonly indexOid: string;
  readonly binary: boolean;
  readonly hunkActions: boolean;
}

export interface TextAnswer {
  readonly text?: string | undefined;
  readonly binary: boolean;
  readonly tooLarge: boolean;
}

export interface LastCommit {
  readonly message?: string | undefined;
  readonly pushed: boolean;
}

export interface CommitMessage {
  readonly text: string;
  readonly model: string;
  readonly fallback: boolean;
  readonly withheld: readonly string[];
}

export interface DeletedBranch {
  readonly name: string;
  readonly oid: string;
  readonly upstream?: string | undefined;
}

export interface DeletedRemoteBranch {
  readonly remote: string;
  readonly branch: string;
  readonly oid: string;
}

export interface OpResult {
  readonly head?: string | undefined;
  readonly subject?: string | undefined;
  readonly restoreId?: string | undefined;
  readonly deleted?: DeletedBranch | undefined;
  readonly deletedRemote?: DeletedRemoteBranch | undefined;
  /** Applying a stash stopped with conflicts and git kept it. */
  readonly stashKept?: boolean | undefined;
  /** An automatic fetch did nothing: another operation held the repository. */
  readonly skipped?: boolean | undefined;
  readonly keptStash?: string | undefined;
  readonly conflicts: readonly string[];
  readonly output?: string | undefined;
}

export type FailureKind =
  | 'notRepo'
  | 'gitMissing'
  | 'untrusted'
  | 'sessionBusy'
  | 'stale'
  | 'busy'
  | 'auth'
  | 'rejected'
  | 'staleLease'
  | 'protected'
  | 'localChanges'
  | 'untrackedOverwritten'
  | 'conflict'
  | 'noUpstream'
  | 'choosePullMode'
  | 'identity'
  | 'nothingToCommit'
  | 'hookFailed'
  | 'inOtherWorktree'
  | 'notMerged'
  | 'noModel'
  | 'invalid'
  | 'cancelled'
  | 'timedOut'
  | 'failed';

export interface Failure {
  readonly kind: FailureKind;
  readonly message?: string | undefined;
  readonly paths: readonly string[];
  readonly sessions: readonly string[];
  readonly command?: string | undefined;
}

/** An answer: the operation's result, or why it did not happen. */
export type Reply<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function optCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Keeps the members that are not undefined (exact optional properties). */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function list<T>(value: unknown, parse: (item: unknown) => T | undefined): T[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = parse(item);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
}

const STATUSES: readonly FileStatus[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'typeChanged',
  'untracked',
  'conflicted',
];

function fileStatus(value: unknown): FileStatus | undefined {
  return STATUSES.find((s) => s === value);
}

function baseOf(value: unknown): GitBase | undefined {
  if (!isRecord(value)) return undefined;
  const name = str(value.name);
  const reference = str(value.reference);
  if (name === undefined || reference === undefined) return undefined;
  return defined({ name, reference, mergeBase: str(value.mergeBase) });
}

function stateOf(value: unknown): RepoState {
  if (!isRecord(value)) return { kind: 'clean' };
  switch (value.kind) {
    case 'merging':
      return defined({ kind: 'merging' as const, source: str(value.source) });
    case 'rebasing':
      return defined({
        kind: 'rebasing' as const,
        branch: str(value.branch),
        onto: str(value.onto),
        step: optCount(value.step),
        total: optCount(value.total),
      });
    case 'cherryPicking':
      return defined({ kind: 'cherryPicking' as const, commit: str(value.commit) });
    case 'reverting':
      return defined({ kind: 'reverting' as const, commit: str(value.commit) });
    default:
      return { kind: 'clean' };
  }
}

function repositoryOf(value: unknown): Repository | undefined {
  if (!isRecord(value)) return undefined;
  const root = str(value.root);
  if (root === undefined) return undefined;
  return defined({
    root,
    branch: str(value.branch),
    head: str(value.head),
    detached: value.detached === true,
    upstream: str(value.upstream),
    ahead: count(value.ahead),
    behind: count(value.behind),
    state: stateOf(value.state),
    remotes: strings(value.remotes),
    base: baseOf(value.base),
    writable: value.writable === true,
    protected: value.protected === true,
    added: count(value.added),
    removed: count(value.removed),
  });
}

function statusFileOf(value: unknown): StatusFile | undefined {
  if (!isRecord(value)) return undefined;
  const path = str(value.path);
  if (path === undefined) return undefined;
  return defined({
    path,
    oldPath: str(value.oldPath),
    staged: fileStatus(value.staged),
    unstaged: fileStatus(value.unstaged),
    conflict: str(value.conflict),
    submodule: value.submodule === true,
    added: optCount(value.added),
    removed: optCount(value.removed),
  });
}

export function statusOf(value: unknown): Status | undefined {
  if (!isRecord(value)) return undefined;
  const repository = repositoryOf(value.repository);
  if (repository === undefined) return undefined;
  return {
    repository,
    files: list(value.files, statusFileOf),
    truncated: value.truncated === true,
    fingerprint: str(value.fingerprint) ?? '',
  };
}

export function scopeOf(value: unknown): Scope | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'uncommitted') return { kind: 'uncommitted' };
  if (value.kind === 'commit' && typeof value.sha === 'string')
    return { kind: 'commit', sha: value.sha };
  if (value.kind === 'branch') return defined({ kind: 'branch' as const, base: str(value.base) });
  return undefined;
}

function fileChangeOf(value: unknown): FileChange | undefined {
  if (!isRecord(value)) return undefined;
  const path = str(value.path);
  const status = fileStatus(value.status);
  if (path === undefined || status === undefined) return undefined;
  return defined({
    path,
    oldPath: str(value.oldPath),
    status,
    added: optCount(value.added),
    removed: optCount(value.removed),
    binary: value.binary === true,
    oldMode: str(value.oldMode),
    newMode: str(value.newMode),
    submodule: value.submodule === true,
    diff: fileDiffOf(value.diff, path),
  });
}

export { fileChangeOf };

export function changesOf(value: unknown): Changes | undefined {
  if (!isRecord(value)) return undefined;
  const scope = scopeOf(value.scope);
  if (scope === undefined) return undefined;
  return defined({
    scope,
    base: baseOf(value.base),
    files: list(value.files, fileChangeOf),
    added: count(value.added),
    removed: count(value.removed),
    withheld: value.withheld === true,
    truncated: value.truncated === true,
  });
}

function commitOf(value: unknown): CommitRow | undefined {
  if (!isRecord(value)) return undefined;
  const sha = str(value.sha);
  if (sha === undefined) return undefined;
  return {
    sha,
    short: str(value.short) ?? sha.slice(0, 7),
    subject: str(value.subject) ?? '',
    author: str(value.author) ?? '',
    time: count(value.time),
  };
}

export function commitsOf(value: unknown): Commits | undefined {
  if (!isRecord(value)) return undefined;
  return defined({
    base: baseOf(value.base),
    commits: list(value.commits, commitOf),
    total: count(value.total),
  });
}

function localBranchOf(value: unknown): LocalBranch | undefined {
  if (!isRecord(value)) return undefined;
  const name = str(value.name);
  const oid = str(value.oid);
  if (name === undefined || oid === undefined) return undefined;
  return defined({
    name,
    oid,
    upstream: str(value.upstream),
    ahead: optCount(value.ahead),
    behind: optCount(value.behind),
    gone: value.gone === true,
    current: value.current === true,
    worktree: str(value.worktree),
    time: count(value.time),
  });
}

function remoteBranchOf(value: unknown): RemoteBranch | undefined {
  if (!isRecord(value)) return undefined;
  const remote = str(value.remote);
  const name = str(value.name);
  const oid = str(value.oid);
  if (remote === undefined || name === undefined || oid === undefined) return undefined;
  return { remote, name, oid, time: count(value.time) };
}

export function branchesOf(value: unknown): Branches | undefined {
  if (!isRecord(value)) return undefined;
  return {
    local: list(value.local, localBranchOf),
    remote: list(value.remote, remoteBranchOf),
    recent: strings(value.recent),
    remotes: strings(value.remotes),
  };
}

export function fileStagesOf(value: unknown): FileStages | undefined {
  if (!isRecord(value)) return undefined;
  const path = str(value.path);
  if (path === undefined) return undefined;
  return defined({
    path,
    staged: fileDiffOf(value.staged, path),
    unstaged: fileDiffOf(value.unstaged, path),
    stagedHashes: strings(value.stagedHashes),
    hunkHashes: strings(value.hunkHashes),
    worktreeHash: str(value.worktreeHash) ?? 'absent',
    indexOid: str(value.indexOid) ?? 'absent',
    binary: value.binary === true,
    hunkActions: value.hunkActions === true,
  });
}

export function textOf(value: unknown): TextAnswer | undefined {
  if (!isRecord(value)) return undefined;
  return defined({
    text: str(value.text),
    binary: value.binary === true,
    tooLarge: value.tooLarge === true,
  });
}

export function lastCommitOf(value: unknown): LastCommit | undefined {
  if (!isRecord(value)) return undefined;
  return defined({ message: str(value.message), pushed: value.pushed === true });
}

export function commitMessageOf(value: unknown): CommitMessage | undefined {
  if (!isRecord(value)) return undefined;
  const text = str(value.text);
  if (text === undefined) return undefined;
  return {
    text,
    model: str(value.model) ?? '',
    fallback: value.fallback === true,
    withheld: strings(value.withheld),
  };
}

export function opResultOf(value: unknown): OpResult | undefined {
  if (!isRecord(value)) return undefined;
  const deleted = isRecord(value.deleted) ? value.deleted : undefined;
  const name = str(deleted?.name);
  const oid = str(deleted?.oid);
  const gone = isRecord(value.deletedRemote) ? value.deletedRemote : undefined;
  const remote = str(gone?.remote);
  const branch = str(gone?.branch);
  const remoteOid = str(gone?.oid);
  return defined({
    deletedRemote:
      remote === undefined || branch === undefined || remoteOid === undefined
        ? undefined
        : { remote, branch, oid: remoteOid },
    stashKept: value.stashKept === true ? true : undefined,
    skipped: value.skipped === true ? true : undefined,
    head: str(value.head),
    subject: str(value.subject),
    restoreId: str(value.restoreId),
    deleted:
      name === undefined || oid === undefined
        ? undefined
        : defined({ name, oid, upstream: str(deleted?.upstream) }),
    keptStash: str(value.keptStash),
    conflicts: strings(value.conflicts),
    output: str(value.output),
  });
}

export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export interface RefLabel {
  readonly kind: RefKind;
  readonly name: string;
  readonly current?: boolean | undefined;
}

export interface LogCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly subject: string;
  readonly author: string;
  readonly email: string;
  readonly time: number;
  readonly refs: readonly RefLabel[];
}

export interface LogPage {
  readonly commits: readonly LogCommit[];
  readonly more: boolean;
}

export interface CommitDetail {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly authorEmail: string;
  readonly authorTime: number;
  readonly committer: string;
  readonly committerEmail: string;
  readonly commitTime: number;
  readonly message: string;
  readonly refs: readonly RefLabel[];
  readonly inHead: boolean;
  readonly pushed: boolean;
}

export interface StashEntry {
  readonly index: number;
  readonly oid: string;
  readonly message: string;
  readonly branch?: string | undefined;
  readonly time: number;
}

export interface Blob {
  readonly data?: string | undefined;
  readonly size: number;
  readonly tooLarge?: boolean | undefined;
}

const REF_KINDS: readonly RefKind[] = ['head', 'local', 'remote', 'tag'];

function refOf(value: unknown): RefLabel | undefined {
  if (!isRecord(value)) return undefined;
  const kind = REF_KINDS.find((k) => k === value.kind);
  const name = str(value.name);
  if (kind === undefined || name === undefined) return undefined;
  return defined({ kind, name, current: value.current === true ? true : undefined });
}

function logCommitOf(value: unknown): LogCommit | undefined {
  if (!isRecord(value)) return undefined;
  const sha = str(value.sha);
  if (sha === undefined) return undefined;
  return {
    sha,
    parents: strings(value.parents),
    subject: str(value.subject) ?? '',
    author: str(value.author) ?? '',
    email: str(value.email) ?? '',
    time: count(value.time),
    refs: list(value.refs, refOf),
  };
}

export function logOf(value: unknown): LogPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.commits)) return undefined;
  return { commits: list(value.commits, logCommitOf), more: value.more === true };
}

export function commitDetailOf(value: unknown): CommitDetail | undefined {
  if (!isRecord(value)) return undefined;
  const sha = str(value.sha);
  if (sha === undefined) return undefined;
  return {
    sha,
    parents: strings(value.parents),
    author: str(value.author) ?? '',
    authorEmail: str(value.authorEmail) ?? '',
    authorTime: count(value.authorTime),
    committer: str(value.committer) ?? '',
    committerEmail: str(value.committerEmail) ?? '',
    commitTime: count(value.commitTime),
    message: str(value.message) ?? '',
    refs: list(value.refs, refOf),
    inHead: value.inHead === true,
    pushed: value.pushed === true,
  };
}

function stashOf(value: unknown): StashEntry | undefined {
  if (!isRecord(value)) return undefined;
  const oid = str(value.oid);
  const index = optCount(value.index);
  if (oid === undefined || index === undefined) return undefined;
  return defined({
    index,
    oid,
    message: str(value.message) ?? '',
    branch: str(value.branch),
    time: count(value.time),
  });
}

export function stashesOf(value: unknown): readonly StashEntry[] | undefined {
  return isRecord(value) && Array.isArray(value.entries) ? list(value.entries, stashOf) : undefined;
}

export function blobOf(value: unknown): Blob | undefined {
  if (!isRecord(value)) return undefined;
  return defined({
    data: str(value.data),
    size: count(value.size),
    tooLarge: value.tooLarge === true ? true : undefined,
  });
}

export function probeOf(value: unknown): string | undefined {
  return isRecord(value) ? str(value.fingerprint) : undefined;
}

const FAILURES: readonly FailureKind[] = [
  'notRepo',
  'gitMissing',
  'untrusted',
  'sessionBusy',
  'stale',
  'busy',
  'auth',
  'rejected',
  'staleLease',
  'protected',
  'localChanges',
  'untrackedOverwritten',
  'conflict',
  'noUpstream',
  'choosePullMode',
  'identity',
  'nothingToCommit',
  'hookFailed',
  'inOtherWorktree',
  'notMerged',
  'noModel',
  'invalid',
  'cancelled',
  'timedOut',
  'failed',
];

export function failureOf(value: unknown): Failure {
  if (!isRecord(value)) return { kind: 'failed', paths: [], sessions: [] };
  return defined({
    kind: FAILURES.find((k) => k === value.kind) ?? 'failed',
    message: str(value.message),
    paths: strings(value.paths),
    sessions: strings(value.sessions),
    command: str(value.command),
  });
}

/** The reply in Core's JSON text, its result parsed by `parse`. */
export function replyOf<T>(text: string, parse: (value: unknown) => T | undefined): Reply<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failure: { kind: 'failed', message: 'unreadable answer', paths: [], sessions: [] },
    };
  }
  if (isRecord(value) && 'failure' in value)
    return { ok: false, failure: failureOf(value.failure) };
  const parsed = isRecord(value) ? parse(value.result) : undefined;
  if (parsed === undefined) {
    return {
      ok: false,
      failure: { kind: 'failed', message: 'unexpected answer', paths: [], sessions: [] },
    };
  }
  return { ok: true, value: parsed };
}

/** A request; the transport's own errors (IPC, invalid arguments) become failures too. */
export async function gitCall<T>(
  sessionId: string,
  request: Record<string, unknown>,
  parse: (value: unknown) => T | undefined,
  opId?: string,
): Promise<Reply<T>> {
  try {
    return replyOf(await window.piarc.git(sessionId, request, opId), parse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: { kind: 'failed', message, paths: [], sessions: [] } };
  }
}
