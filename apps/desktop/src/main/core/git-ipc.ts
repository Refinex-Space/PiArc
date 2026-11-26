// The Git panel's commands (ADR-0084, ADR-0085). One channel carries every request: the main
// process checks its shape, requires recent real input in the window for anything that writes,
// fills the interface language of a commit message, and asks natively before an operation that
// loses work (rollback, discarding checkout, force push, deleting an unmerged branch), showing
// facts Core read; Core checks the values again and runs git.
import { BrowserWindow } from 'electron';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { Locale, MessageId, Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';
import type { NativeConfirm, ShownConfirmation } from './plugins-ipc.js';

/** The part of Core these commands use. */
export type GitCore = Pick<CoreRuntime, 'gitRequest' | 'cancelGit'>;

/** Real input in the window (or a docked tool window of the session) within a few seconds. */
export interface InputGuard {
  requireInput(
    contents: Electron.WebContents,
    target?: string | number,
    panel?: 'terminal' | 'files' | 'changes',
  ): void;
}

type Json = Record<string, unknown>;

const MAX_PATH = 4096;
const MAX_PATHS = 10_000;
const MAX_NAME = 255;
const MAX_MESSAGE = 64 * 1024;
const MAX_INSTRUCTIONS = 8 * 1024;
const MAX_OP_ID = 128;
/** Paths a confirmation lists before "and N more". */
const LISTED = 10;

const READ_ONLY = new Set([
  'probe',
  'status',
  'changes',
  'fileDiff',
  'fileText',
  'commits',
  'branches',
  'fileStages',
  'lastCommit',
]);

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw new TypeError('sessionId must be a session id');
  }
  return value;
}

function text(value: unknown, name: string, max: number, control = false): string {
  if (typeof value !== 'string' || value.length > max || (!control && hasControl(value))) {
    throw new TypeError(`${name} must be a string of at most ${String(max)} characters`);
  }
  return value;
}

function name(value: unknown, field: string): string {
  const v = text(value, field, MAX_NAME);
  if (v.length === 0 || v.startsWith('-')) throw new TypeError(`${field} is not a name`);
  return v;
}

function filePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH) {
    throw new TypeError('a path must be a non-empty string');
  }
  if (value.includes('\0')) throw new TypeError('a path cannot contain NUL');
  return value;
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS) {
    throw new TypeError('paths must be a non-empty list');
  }
  return value.map(filePath);
}

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function optionalName(value: unknown, field: string): string | undefined {
  return value === undefined || value === null ? undefined : name(value, field);
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function scope(value: unknown): Json {
  if (!isRecord(value)) throw new TypeError('scope must be an object');
  const kind = oneOf(value.kind, 'scope.kind', ['branch', 'uncommitted', 'commit'] as const);
  if (kind === 'commit') return { kind, sha: name(value.sha, 'scope.sha') };
  if (kind === 'branch') {
    const base = optionalName(value.base, 'scope.base');
    return base === undefined ? { kind } : { kind, base };
  }
  return { kind };
}

function hunk(value: unknown): Json {
  if (!isRecord(value)) throw new TypeError('hunk must be an object');
  const index = value.index;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('hunk.index must be a non-negative integer');
  }
  return {
    path: filePath(value.path),
    stage: oneOf(value.stage, 'hunk.stage', ['staged', 'unstaged'] as const),
    index,
    hash: name(value.hash, 'hunk.hash'),
    worktreeHash: name(value.worktreeHash, 'hunk.worktreeHash'),
    indexOid: name(value.indexOid, 'hunk.indexOid'),
  };
}

function target(value: unknown): Json | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new TypeError('target must be an object');
  return {
    remote: name(value.remote, 'target.remote'),
    branch: name(value.branch, 'target.branch'),
  };
}

function compact(fields: Json): Json {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** The request with known members only, checked; throws `TypeError` otherwise. */
export function gitRequest(raw: unknown): Json {
  if (!isRecord(raw)) throw new TypeError('request must be an object');
  const op = text(raw.op, 'op', 32);
  switch (op) {
    case 'probe':
    case 'status':
    case 'branches':
    case 'lastCommit':
    case 'fetch':
    case 'continue':
    case 'abort':
    case 'skip':
      return { op };
    case 'changes':
      return compact({
        op,
        scope: scope(raw.scope),
        ignoreWhitespace: flag(raw.ignoreWhitespace, 'ignoreWhitespace'),
      });
    case 'fileDiff':
      return compact({
        op,
        scope: scope(raw.scope),
        path: filePath(raw.path),
        oldPath:
          raw.oldPath === undefined || raw.oldPath === null ? undefined : filePath(raw.oldPath),
        ignoreWhitespace: flag(raw.ignoreWhitespace, 'ignoreWhitespace'),
      });
    case 'fileText': {
      if (!isRecord(raw.source)) throw new TypeError('source must be an object');
      const kind = oneOf(raw.source.kind, 'source.kind', ['commit', 'index', 'worktree'] as const);
      const source =
        kind === 'commit' ? { kind, rev: name(raw.source.rev, 'source.rev') } : { kind };
      return { op, source, path: filePath(raw.path) };
    }
    case 'commits':
      return compact({ op, base: optionalName(raw.base, 'base') });
    case 'fileStages':
      return { op, path: filePath(raw.path) };
    case 'stage':
    case 'unstage':
    case 'rollback':
    case 'markResolved':
      return { op, paths: paths(raw.paths) };
    case 'stageHunk':
    case 'unstageHunk':
    case 'rollbackHunk':
      return { op, hunk: hunk(raw.hunk) };
    case 'undoRollback':
      return { op, restoreId: name(raw.restoreId, 'restoreId') };
    case 'commit':
      return compact({
        op,
        message: text(raw.message, 'message', MAX_MESSAGE, true),
        amend: flag(raw.amend, 'amend'),
        signoff: flag(raw.signoff, 'signoff'),
      });
    case 'commitMessage':
      return compact({
        op,
        instructions: text(raw.instructions, 'instructions', MAX_INSTRUCTIONS, true),
        amend: flag(raw.amend, 'amend'),
      });
    case 'checkout':
      return compact({
        op,
        target: name(raw.target, 'target'),
        mode:
          raw.mode === undefined || raw.mode === null
            ? undefined
            : oneOf(raw.mode, 'mode', ['normal', 'smart', 'force'] as const),
      });
    case 'createBranch':
      return compact({
        op,
        name: name(raw.name, 'name'),
        start: optionalName(raw.start, 'start'),
        checkout: flag(raw.checkout, 'checkout'),
      });
    case 'renameBranch':
      return { op, from: name(raw.from, 'from'), to: name(raw.to, 'to') };
    case 'deleteBranch':
      return compact({ op, name: name(raw.name, 'name'), force: flag(raw.force, 'force') });
    case 'restoreBranch':
      return compact({
        op,
        name: name(raw.name, 'name'),
        oid: name(raw.oid, 'oid'),
        upstream: optionalName(raw.upstream, 'upstream'),
      });
    case 'setUpstream':
      return compact({
        op,
        branch: name(raw.branch, 'branch'),
        upstream: optionalName(raw.upstream, 'upstream'),
      });
    case 'pull':
      return compact({
        op,
        mode:
          raw.mode === undefined || raw.mode === null
            ? undefined
            : oneOf(raw.mode, 'mode', ['config', 'merge', 'rebase', 'ffOnly'] as const),
      });
    case 'push':
      return compact({ op, target: target(raw.target), force: flag(raw.force, 'force') });
    default:
      throw new TypeError(`unknown Git operation ${op}`);
  }
}

/** The `describe` action that a request needs confirmed natively, if any. */
export function confirmationFor(request: Json): Json | undefined {
  switch (request.op) {
    case 'rollback':
      return { kind: 'rollback', paths: request.paths };
    case 'rollbackHunk':
      return { kind: 'rollbackHunk', hunk: request.hunk };
    case 'checkout':
      return request.mode === 'force'
        ? { kind: 'forceCheckout', target: request.target }
        : undefined;
    case 'push':
      return request.force === true
        ? compact({ kind: 'forcePush', target: request.target })
        : undefined;
    case 'deleteBranch':
      return request.force === true ? { kind: 'deleteBranch', name: request.name } : undefined;
    default:
      return undefined;
  }
}

/** Bidirectional controls shown as escapes, so a crafted name cannot reorder the dialog. */
export function reveal(value: string): string {
  return value.replace(/[؜‎‏‪-‮⁦-⁩]/gu, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
}

function listed(t: Translator, values: readonly string[]): string {
  const shown = values.slice(0, LISTED).map((v) => `• ${reveal(v)}`);
  if (values.length > LISTED)
    shown.push(t.t('git.confirm.more', { count: values.length - LISTED }));
  return shown.join('\n');
}

function short(oid: unknown): string {
  return typeof oid === 'string' ? oid.slice(0, 12) : '—';
}

/** The dialog's text and confirming button for `action` with Core's description. */
export function confirmationText(
  t: Translator,
  action: Json,
  described: Json,
): { text: ShownConfirmation; button: string } {
  const files = Array.isArray(described.paths)
    ? described.paths.filter((p): p is string => typeof p === 'string')
    : [];
  const branch = reveal(typeof described.branch === 'string' ? described.branch : '');
  const message = (id: MessageId, values: Record<string, string | number> = {}) => t.t(id, values);
  switch (action.kind) {
    case 'rollback':
      return {
        text: {
          message: message('git.confirm.rollback', { count: files.length }),
          detail: `${message('git.confirm.rollbackDetail')}\n\n${listed(t, files)}`,
        },
        button: message('git.confirm.rollbackButton'),
      };
    case 'rollbackHunk':
      return {
        text: {
          message: message('git.confirm.rollbackHunk', { path: reveal(files[0] ?? '') }),
          detail: message('git.confirm.rollbackDetail'),
        },
        button: message('git.confirm.rollbackButton'),
      };
    case 'forceCheckout':
      return {
        text: {
          message: message('git.confirm.forceCheckout', { target: branch }),
          detail: `${message('git.confirm.forceCheckoutDetail')}\n\n${listed(t, files)}`,
        },
        button: message('git.confirm.forceCheckoutButton'),
      };
    case 'deleteBranch':
      return {
        text: {
          message: message('git.confirm.deleteBranch', { branch }),
          detail: message('git.confirm.deleteBranchDetail', {
            count: typeof described.unmerged === 'number' ? described.unmerged : 0,
          }),
        },
        button: message('git.confirm.deleteBranchButton'),
      };
    default:
      return {
        text: {
          message: message('git.confirm.forcePush', {
            branch,
            remote: reveal(typeof described.remote === 'string' ? described.remote : ''),
          }),
          detail: message('git.confirm.forcePushDetail', {
            remoteOid: short(described.remoteOid),
            localOid: short(described.localOid),
          }),
        },
        button: message('git.confirm.forcePushButton'),
      };
  }
}

const CANCELLED = JSON.stringify({ failure: { kind: 'cancelled' } });

function parse(json: string): Json {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new TypeError('Core answered something that is not an object');
  return value;
}

/** Registers the Git panel's commands. */
export function registerGitHandlers(
  registerHandler: RegisterHandler,
  core: GitCore,
  translator: () => Translator,
  confirm: NativeConfirm,
  input: InputGuard,
  locale: () => Locale,
): void {
  registerHandler(IPC_CHANNELS.gitRequest, async (event, [id, raw, opId]) => {
    const session = sessionId(id);
    const request = gitRequest(raw);
    const op =
      typeof opId === 'string' && opId.length <= MAX_OP_ID && !hasControl(opId) ? opId : undefined;
    if (!READ_ONLY.has(String(request.op))) input.requireInput(event.sender, session, 'changes');
    if (request.op === 'commitMessage') request.language = locale() === 'zh-CN' ? 'zh-CN' : 'en';
    const action = confirmationFor(request);
    if (action !== undefined) {
      const described = parse(
        await core.gitRequest(session, JSON.stringify({ request: { op: 'describe', action } })),
      );
      if (!isRecord(described.result)) return JSON.stringify(described);
      const facts = described.result;
      if (isRecord(facts.refused)) return JSON.stringify({ failure: facts.refused });
      const t = translator();
      const { text: shown, button } = confirmationText(t, action, facts);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!(await confirm.ask(window, shown, [button, t.t('dialog.cancel')]))) return CANCELLED;
      if (request.op === 'push' && typeof facts.remoteOid === 'string') {
        request.expect = facts.remoteOid;
      }
    }
    return core.gitRequest(
      session,
      JSON.stringify(op === undefined ? { request } : { opId: op, request }),
    );
  });
  registerHandler(IPC_CHANNELS.gitCancel, (_event, [opId]) => {
    if (typeof opId !== 'string' || opId.length === 0 || opId.length > MAX_OP_ID) {
      throw new TypeError('opId must be a short string');
    }
    return core.cancelGit(opId);
  });
}
