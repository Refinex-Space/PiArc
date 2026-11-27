// The session, workspace, trust and composer commands of `window.piarc` (T18, T19): each
// validates its arguments (they come from the renderer) and calls Core. Results are Core's JSON text, passed
// through unread (the renderer validates them). Deleting a session is irreversible, so the
// main process asks the user in a native dialog before it calls Core (architecture section
// 10.3): a page cannot delete a session without the user's click in that dialog.
import path from 'node:path';

import { BrowserWindow, dialog, shell } from 'electron';
import {
  isPermissionMode,
  type DiscardRequest,
  type PlanComment,
  type QuestionAnswer,
  type RewindRequest,
} from '@piarc/protocol';

import {
  type ApprovalAnswer,
  IPC_CHANNELS,
  MAX_ATTACHMENT_IPC_BYTES,
  MAX_PROMPT_LENGTH,
  isSessionId,
  isWorktreeName,
} from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import { electronExternalLinkPort } from '../external-link-port.js';
import { LinkConfirmations, parseExternalUrl } from '../external-links.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';
import { registerSideChatHandlers } from './side-chat-ipc.js';
import { DraftSessions } from './draft-sessions.js';
import { removeWorkspace } from './workspace-removal.js';

/** The part of Core these commands use. */
export type SessionCore = Pick<
  CoreRuntime,
  | 'openWorkspace'
  | 'workspaceWork'
  | 'removeWorkspace'
  | 'createSession'
  | 'createDraftSession'
  | 'discardDraftSession'
  | 'createWorktreeSession'
  | 'resumeSession'
  | 'closeSession'
  | 'prompt'
  | 'promptInput'
  | 'steer'
  | 'steerInput'
  | 'followUp'
  | 'followUpInput'
  | 'abort'
  | 'askSideChat'
  | 'controlSideChat'
  | 'answerApproval'
  | 'setPermissionMode'
  | 'compact'
  | 'contextUsage'
  | 'rewindPreview'
  | 'rewind'
  | 'undoRewind'
  | 'sessionChanges'
  | 'discardChange'
  | 'switchBranch'
  | 'forkSession'
  | 'editQueueItem'
  | 'deleteQueueItem'
  | 'storeAttachment'
  | 'searchFiles'
  | 'cancelFileSearch'
  | 'providerSettings'
  | 'saveProvider'
  | 'deleteProvider'
  | 'setCatalogRefresh'
  | 'setModelPreferences'
  | 'startLogin'
  | 'answerLogin'
  | 'logoutProvider'
  | 'setProviderEnabled'
  | 'testProvider'
  | 'discoverModels'
  | 'useProviderAccount'
  | 'removeProviderAccount'
  | 'workspaceModels'
  | 'sessionModels'
  | 'previewModelSwitch'
  | 'setSessionModel'
  | 'setSessionEffort'
  | 'composerInfo'
  | 'markSessionRead'
  | 'renameSession'
  | 'setSessionPinned'
  | 'setSessionArchived'
  | 'sessionDeletionTarget'
  | 'deleteSession'
  | 'transcriptWindow'
  | 'subagentTranscript'
  | 'stopSubagent'
  | 'stopTask'
  | 'readTaskOutput'
  | 'listAgents'
  | 'listCommands'
  | 'listSkills'
  | 'setOutputStyle'
  | 'webSearchSettings'
  | 'setWebSearchBackend'
  | 'setWebSearchKey'
  | 'managedSettings'
  | 'memoryView'
  | 'memoryEdit'
  | 'resendSnapshots'
  | 'projectTrust'
  | 'decideProjectTrust'
>;

/**
 * Failures a test asks for (development builds' test hooks only): the next call on a channel
 * fails with the given message instead of reaching Core (T18-A07).
 */
export class FaultInjector {
  private readonly pending = new Map<string, string>();
  private readonly holds = new Map<string, number>();

  failNext(channel: string, message: string): void {
    this.pending.set(channel, message);
  }

  /** The next answer on `channel` reaches the window `ms` after Core gave it. */
  holdNext(channel: string, ms: number): void {
    this.holds.set(channel, ms);
  }

  /** Waits the hold planned for `channel`, if any. */
  async hold(channel: string): Promise<void> {
    const ms = this.holds.get(channel);
    if (ms === undefined) {
      return;
    }
    this.holds.delete(channel);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Throws the failure planned for `channel`, if any. */
  check(channel: string): void {
    const message = this.pending.get(channel);
    if (message !== undefined) {
      this.pending.delete(channel);
      throw new Error(message);
    }
  }
}

/** Longest session title, in characters (Core's limit). */
const MAX_TITLE = 200;

/** A background task id as Core makes them (T32): `bg-` and 12 hexadecimal digits. */
function taskId(value: unknown): string {
  if (typeof value !== 'string' || !/^bg-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError('invalid task id');
  }
  return value;
}

function sessionId(value: unknown): string {
  if (!isSessionId(value)) {
    throw new TypeError('sessionId must be a session id');
  }
  return value;
}

function absolutePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    !path.isAbsolute(value)
  ) {
    throw new TypeError('path must be an absolute path');
  }
  return value;
}

/** The new-session form's worktree choice (T35): a valid name and a short base, both optional. */
function worktreeOptions(value: unknown): { name?: string; base?: string } {
  if (typeof value !== 'object' || value === null) throw new TypeError('invalid worktree');
  const tree = value as Record<string, unknown>;
  const options: { name?: string; base?: string } = {};
  if (tree.name !== undefined) {
    if (!isWorktreeName(tree.name)) throw new TypeError('invalid worktree name');
    options.name = tree.name;
  }
  if (tree.base !== undefined) {
    if (
      typeof tree.base !== 'string' ||
      tree.base.length === 0 ||
      tree.base.length > 256 ||
      Array.from(tree.base, (c) => c.charCodeAt(0)).some((code) => code < 0x20 || code === 0x7f)
    ) {
      throw new TypeError('invalid worktree base');
    }
    options.base = tree.base;
  }
  return options;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function title(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || Array.from(value).length > MAX_TITLE) {
    throw new TypeError(
      `title must be a string of at most ${String(MAX_TITLE)} characters, or null`,
    );
  }
  return value;
}

/** Ids the renderer chooses (request keys, queue items, searches): Core's key alphabet. */
/** The recorded name of `account` of `provider` in Core's provider settings (ADR-0083). */
export function accountLabel(
  settings: string,
  provider: string,
  account: string,
): string | undefined {
  try {
    const parsed: unknown = JSON.parse(settings);
    if (typeof parsed !== 'object' || parsed === null || !('accounts' in parsed)) return undefined;
    const accounts = parsed.accounts;
    if (!Array.isArray(accounts)) return undefined;
    for (const entry of accounts as unknown[]) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        'provider' in entry &&
        'id' in entry &&
        entry.provider === provider &&
        entry.id === account
      ) {
        return 'label' in entry && typeof entry.label === 'string' ? entry.label : undefined;
      }
    }
  } catch {
    // Not JSON: no name.
  }
  return undefined;
}

function token(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new TypeError(`${name} must be 1 to 128 letters, digits, '.', '_', ':' or '-'`);
  }
  return value;
}

/** Rules to save: one to five non-empty lines of at most 4,096 characters each. */
function ruleList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 5) throw new TypeError('invalid rules');
  return value.map((rule) => {
    const checked = text(rule, 'rule');
    if (checked.length > 4096 || /[\r\n]/.test(checked)) throw new TypeError('invalid rule');
    return checked;
  });
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_PROMPT_LENGTH
  ) {
    throw new TypeError(`${name} must be a string of at most ${String(MAX_PROMPT_LENGTH)} units`);
  }
  return value;
}

function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new TypeError(`${name} must be an array of at most ${String(max)} entries`);
  }
  return value;
}

/**
 * The composer's input as JSON for Core: the shape is checked here (types and sizes), the
 * meaning (spans inside the text, attachments of this session) by Core.
 */
function input(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('input must be an object');
  }
  const fields = value as Record<string, unknown>;
  const message = {
    requestId: token(fields.requestId, 'requestId'),
    text: text(fields.text, 'text', true),
    mentions: list(fields.mentions, 'mentions', 100),
    attachments: list(fields.attachments, 'attachments', 10),
  };
  if (message.text.trim() === '' && message.attachments.length === 0) {
    throw new TypeError('input must have text or attachments');
  }
  return JSON.stringify(message);
}

/** A path Core named in a rewind preview or the Changes view (absolute, at most 4,096). */
function corePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError('path must be a path Core reported');
  }
  return value;
}

/** A content version Core reported: 64 hex digits or `absent`. */
function version(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{64}|absent)$/u.test(value)) {
    throw new TypeError('version must be a version Core reported');
  }
  return value;
}

const REWIND_SCOPES = new Set(['codeAndConversation', 'conversation', 'code', 'summarize']);

/** A rewind request: the shape is checked here, the files and versions by Core. */
function rewindRequest(value: unknown): RewindRequest {
  const fields = record(value, 'request');
  const scope = fields.scope;
  if (typeof scope !== 'string' || !REWIND_SCOPES.has(scope)) {
    throw new TypeError('scope must be a rewind scope');
  }
  const choices = list(fields.choices ?? [], 'choices', 10_000).map((choice) => {
    const c = record(choice, 'choice');
    return {
      path: corePath(c.path),
      version: version(c.version),
      overwrite: flag(c.overwrite, 'overwrite'),
    };
  });
  return {
    turnId: token(fields.turnId, 'turnId'),
    scope: scope as RewindRequest['scope'],
    ...(choices.length === 0 ? {} : { choices }),
  };
}

function discardRequest(value: unknown): DiscardRequest {
  const fields = record(value, 'request');
  return {
    path: corePath(fields.path),
    version: version(fields.version),
    ...(fields.hunk === undefined ? {} : { hunk: nonnegative(fields.hunk, 'hunk') }),
  };
}

function nonnegative(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Inline comments on a plan: UTF-16 ranges with the quoted text and the comment. */
function planComments(value: unknown): PlanComment[] {
  return list(value, 'comments', 200).map((entry) => {
    const c = record(entry, 'comment');
    return {
      start: nonnegative(c.start, 'start'),
      end: nonnegative(c.end, 'end'),
      quote: text(c.quote, 'quote'),
      text: text(c.text, 'text'),
    };
  });
}

/** One answer per question: picked option labels and an answer of the user's own. */
function questionAnswers(value: unknown): QuestionAnswer[] {
  return list(value, 'answers', 4).map((entry) => {
    const q = record(entry, 'answer');
    return {
      ...(q.selected === undefined
        ? {}
        : { selected: list(q.selected, 'selected', 8).map((label) => text(label, 'label')) }),
      ...(q.other === undefined ? {} : { other: text(q.other, 'other') }),
    };
  });
}

function approvalAnswer(value: unknown): ApprovalAnswer {
  if (typeof value !== 'object' || value === null) throw new TypeError('invalid approval answer');
  const a = value as Record<string, unknown>;
  const { decision } = a;
  if (
    decision !== 'allowOnce' &&
    decision !== 'allowSession' &&
    decision !== 'allowAlways' &&
    decision !== 'deny'
  ) {
    throw new TypeError('unknown approval decision');
  }
  const fields = {
    sessionId: sessionId(a.sessionId),
    requestId: token(a.requestId, 'requestId'),
    revision: nonnegative(a.revision, 'revision'),
    connectionEpoch: nonnegative(a.connectionEpoch, 'connectionEpoch'),
    decision,
  } satisfies ApprovalAnswer;
  if (a.elicitation !== undefined) {
    const reply = a.elicitation;
    if (typeof reply !== 'object' || reply === null || !('action' in reply))
      throw new TypeError('invalid MCP response');
    if (decision === 'deny' && (reply.action === 'decline' || reply.action === 'cancel')) {
      return { ...fields, elicitation: { action: reply.action } };
    }
    if (decision !== 'allowOnce' || reply.action !== 'accept')
      throw new TypeError('invalid MCP response action');
    if (a.confirmedUrl !== undefined) {
      const raw = text(a.confirmedUrl, 'confirmedUrl');
      const url = parseExternalUrl(raw);
      if (url === null || !['http:', 'https:'].includes(url.protocol))
        throw new TypeError('invalid MCP URL');
      return { ...fields, elicitation: { action: 'accept' }, confirmedUrl: raw };
    }
    const content = 'content' in reply ? reply.content : undefined;
    if (typeof content !== 'object' || content === null || Array.isArray(content))
      throw new TypeError('invalid MCP form response');
    return {
      ...fields,
      elicitation: {
        action: 'accept',
        content: Object.fromEntries(Object.entries(content)),
      },
    };
  }
  if (decision === 'allowAlways') {
    const rules = a.rules === undefined ? [] : ruleList(a.rules);
    // T39: a network-domain card's "add to allowlist" names its host instead.
    const domain = a.domain === undefined ? undefined : text(a.domain, 'domain');
    if (a.directory === undefined && rules.length === 0 && domain === undefined) {
      throw new TypeError('always allow needs a rule, directory or domain');
    }
    return {
      ...fields,
      ...(rules.length === 0 ? {} : { rules }),
      ...(a.directory === undefined ? {} : { directory: absolutePath(a.directory) }),
      ...(domain === undefined ? {} : { domain }),
    };
  }
  // T26: an approved plan carries its follow-up mode, a declined plan its comments, an answered
  // question form its answers. Core checks them against the card.
  if (decision === 'allowOnce') {
    if (a.mode !== undefined && a.mode !== 'acceptEdits' && a.mode !== 'default') {
      throw new TypeError('mode must be acceptEdits or default');
    }
    return {
      ...fields,
      ...(a.mode === undefined ? {} : { mode: a.mode }),
      ...(a.answers === undefined ? {} : { answers: questionAnswers(a.answers) }),
    };
  }
  return decision === 'deny'
    ? {
        ...fields,
        ...(a.feedback === undefined ? {} : { feedback: text(a.feedback, 'feedback', true) }),
        ...(a.comments === undefined ? {} : { comments: planComments(a.comments) }),
      }
    : fields;
}

/** Registers the session, workspace and trust commands. */
export function registerSessionHandlers(
  registerHandler: RegisterHandler,
  core: SessionCore,
  translator: () => Translator,
  faults: FaultInjector,
  providersChanged: () => void,
): void {
  registerHandler(IPC_CHANNELS.folderDialog, async (event) => {
    const t = translator();
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: t.t('dialog.openFolder.title'),
      buttonLabel: t.t('dialog.openFolder.button'),
      properties: ['openDirectory', 'createDirectory'],
    };
    const result =
      window === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  registerHandler(IPC_CHANNELS.workspaceOpen, async (_event, [dir]) => {
    const opened = await core.openWorkspace(absolutePath(dir));
    await faults.hold(IPC_CHANNELS.workspaceOpen);
    return opened;
  });
  registerHandler(IPC_CHANNELS.workspaceRemove, (event, [dir]) => {
    const target = absolutePath(dir);
    const window = BrowserWindow.fromWebContents(event.sender);
    return removeWorkspace(
      core,
      translator(),
      async (options) => {
        const { response } =
          window === null
            ? await dialog.showMessageBox(options)
            : await dialog.showMessageBox(window, options);
        return response;
      },
      target,
    );
  });
  registerHandler(IPC_CHANNELS.sessionCreate, (_event, [workspace, selected, tree]) => {
    const dir = absolutePath(workspace);
    faults.check(IPC_CHANNELS.sessionCreate);
    let model: { provider: string; id: string } | undefined;
    if (selected != null) {
      if (typeof selected !== 'object' || !('provider' in selected) || !('id' in selected)) {
        throw new TypeError('invalid model');
      }
      model = { provider: token(selected.provider, 'provider'), id: text(selected.id, 'model') };
    }
    if (tree != null) {
      return core.createWorktreeSession(dir, { ...worktreeOptions(tree), ...(model && { model }) });
    }
    return core.createSession(dir, model === undefined ? null : { model });
  });
  const drafts = new DraftSessions(core);
  registerHandler(IPC_CHANNELS.sessionCreateDraft, (event, [workspace]) =>
    drafts.create(event.sender, absolutePath(workspace)),
  );
  registerHandler(IPC_CHANNELS.sessionDiscardDraft, async (event, [id]) => {
    await drafts.discard(event.sender, sessionId(id));
  });
  registerHandler(IPC_CHANNELS.sessionResume, (_event, [id]) => core.resumeSession(sessionId(id)));
  registerHandler(IPC_CHANNELS.sessionClose, (_event, [id]) => core.closeSession(sessionId(id)));
  registerHandler(IPC_CHANNELS.sessionPrompt, (_event, [id, message]) => {
    faults.check(IPC_CHANNELS.sessionPrompt);
    return typeof message === 'string'
      ? core.prompt(sessionId(id), text(message, 'text'))
      : core.promptInput(sessionId(id), input(message));
  });
  registerHandler(IPC_CHANNELS.sessionSteer, (_event, [id, message]) =>
    typeof message === 'string'
      ? core.steer(sessionId(id), text(message, 'text'))
      : core.steerInput(sessionId(id), input(message)),
  );
  registerHandler(IPC_CHANNELS.sessionFollowUp, (_event, [id, message]) =>
    typeof message === 'string'
      ? core.followUp(sessionId(id), text(message, 'text'))
      : core.followUpInput(sessionId(id), input(message)),
  );
  registerHandler(IPC_CHANNELS.sessionAbort, (_event, [id]) => core.abort(sessionId(id)));
  registerSideChatHandlers(registerHandler, core);
  registerHandler(IPC_CHANNELS.sessionPermissionMode, async (event, [id, mode]) => {
    if (!isPermissionMode(mode)) throw new TypeError('unknown permission mode');
    if (mode === 'bypassPermissions') {
      // The second confirmation (the first is enabling the mode in settings); Core also
      // refuses the switch unless the user's own settings enable it.
      const t = translator();
      const window = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        message: t.t('permissions.bypass.confirm'),
        detail: t.t('permissions.bypass.detail'),
        buttons: [t.t('permissions.bypass.switch'), t.t('dialog.cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const result =
        window === null
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(window, options);
      if (result.response !== 0) return;
    }
    await core.setPermissionMode(sessionId(id), mode);
  });
  const elicitationLinks = new LinkConfirmations();
  registerHandler(IPC_CHANNELS.approvalAnswer, async (event, [raw]) => {
    const answer = approvalAnswer(raw);
    if (answer.confirmedUrl != null) {
      const port = electronExternalLinkPort(
        BrowserWindow.fromWebContents(event.sender),
        translator(),
      );
      let status: string | undefined;
      const confirmed = await elicitationLinks.open(event.sender.id, answer.confirmedUrl, {
        confirm: (url) => port.confirm(url),
        open: async (url) => {
          // The card may have been withdrawn while the native dialog was open.
          status = await core.answerApproval(JSON.stringify(answer));
          const result: unknown = JSON.parse(status);
          if (
            typeof result === 'object' &&
            result !== null &&
            'status' in result &&
            result.status === 'applied'
          ) {
            await port.open(url);
          }
        },
      });
      if (confirmed && status !== undefined) return status;
      return core.answerApproval(
        JSON.stringify({
          ...answer,
          confirmedUrl: undefined,
          decision: 'deny',
          elicitation: { action: 'cancel' },
        }),
      );
    }
    if (answer.decision === 'allowAlways') {
      const t = translator();
      const window = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        message: t.t(
          answer.domain != null
            ? 'approval.confirmDomain'
            : answer.directory === undefined
              ? 'approval.confirmRule'
              : 'approval.confirmDirectory',
        ),
        detail: [
          ...(answer.domain == null ? [] : [t.t('sandbox.domains') + '\n' + answer.domain]),
          ...(answer.rules === undefined || answer.rules.length === 0
            ? []
            : [t.t('approval.rule') + '\n' + answer.rules.join('\n')]),
          ...(answer.directory == null
            ? []
            : [t.t('approval.directory') + '\n' + answer.directory]),
        ].join('\n\n'),
        buttons: [t.t('approval.always'), t.t('dialog.cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const result =
        window === null
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(window, options);
      if (result.response !== 0) return JSON.stringify({ status: 'cancelled' });
    }
    return core.answerApproval(JSON.stringify(answer));
  });
  registerHandler(IPC_CHANNELS.sessionCompact, (_event, [id, instructions]) =>
    core.compact(
      sessionId(id),
      instructions === undefined ? undefined : text(instructions, 'instructions'),
    ),
  );
  registerHandler(IPC_CHANNELS.sessionContextUsage, (_event, [id]) =>
    core.contextUsage(sessionId(id)),
  );
  registerHandler(IPC_CHANNELS.sessionRewindPreview, (_event, [id, turnId]) =>
    core.rewindPreview(sessionId(id), token(turnId, 'turnId')),
  );
  registerHandler(IPC_CHANNELS.sessionRewind, (_event, [id, request]) =>
    core.rewind(sessionId(id), JSON.stringify(rewindRequest(request))),
  );
  registerHandler(IPC_CHANNELS.sessionUndoRewind, (_event, [id, restoreId]) =>
    core.undoRewind(sessionId(id), token(restoreId, 'restoreId')),
  );
  registerHandler(IPC_CHANNELS.sessionChanges, (_event, [id, file]) =>
    core.sessionChanges(sessionId(id), file === undefined ? null : corePath(file)),
  );
  registerHandler(IPC_CHANNELS.sessionDiscardChange, (_event, [id, request]) =>
    core.discardChange(sessionId(id), JSON.stringify(discardRequest(request))),
  );
  registerHandler(IPC_CHANNELS.sessionSwitchBranch, (_event, [id, entryId]) =>
    core.switchBranch(sessionId(id), token(entryId, 'entryId')),
  );
  registerHandler(IPC_CHANNELS.sessionFork, (_event, [id, beforeTurn]) =>
    core.forkSession(sessionId(id), null, token(beforeTurn, 'beforeTurn')),
  );
  registerHandler(IPC_CHANNELS.queueEdit, (_event, [id, itemId, value]) =>
    core.editQueueItem(sessionId(id), token(itemId, 'itemId'), text(value, 'text')),
  );
  registerHandler(IPC_CHANNELS.queueDelete, (_event, [id, itemId]) =>
    core.deleteQueueItem(sessionId(id), token(itemId, 'itemId')),
  );
  registerHandler(IPC_CHANNELS.attachmentStore, (_event, [id, name, mimeType, data]) => {
    if (typeof name !== 'string' || name.length > 1024) {
      throw new TypeError('name must be a string of at most 1024 characters');
    }
    if (typeof mimeType !== 'string' || mimeType.length > 128) {
      throw new TypeError('mimeType must be a media type');
    }
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_ATTACHMENT_IPC_BYTES) {
      throw new TypeError(
        `data must be at most ${String(MAX_ATTACHMENT_IPC_BYTES)} bytes in a Uint8Array`,
      );
    }
    return core.storeAttachment(sessionId(id), name, mimeType, data);
  });
  registerHandler(IPC_CHANNELS.filesSearch, (_event, [searchId, root, query, limit]) => {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer from 1 to 1000');
    }
    if (typeof query !== 'string' || query.length > 256) {
      throw new TypeError('query must be a string of at most 256 characters');
    }
    return core.searchFiles(token(searchId, 'searchId'), absolutePath(root), query, limit);
  });
  registerHandler(IPC_CHANNELS.filesCancel, (_event, [searchId]) => {
    core.cancelFileSearch(token(searchId, 'searchId'));
  });
  registerHandler(IPC_CHANNELS.providerSettings, () => core.providerSettings());
  const notifyProviders = (settings: string) => {
    providersChanged();
    return settings;
  };
  registerHandler(IPC_CHANNELS.saveProvider, async (_event, [config, secret]) =>
    notifyProviders(
      await core.saveProvider(
        text(config, 'provider settings'),
        secret == null ? undefined : text(secret, 'credential'),
      ),
    ),
  );
  registerHandler(IPC_CHANNELS.deleteProvider, async (event, [value]) => {
    const id = token(value, 'provider');
    const t = translator();
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: t.t('providers.confirmDelete', { id }),
      buttons: [t.t('dialog.delete.confirm'), t.t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
    };
    const dialogResult =
      window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    return dialogResult.response === 0 ? notifyProviders(await core.deleteProvider(id)) : null;
  });
  registerHandler(IPC_CHANNELS.setCatalogRefresh, async (_event, [enabled]) =>
    notifyProviders(await core.setCatalogRefresh(flag(enabled, 'enabled'))),
  );
  registerHandler(IPC_CHANNELS.setModelPreferences, async (_event, [preferences]) =>
    notifyProviders(await core.setModelPreferences(text(preferences, 'model preferences'))),
  );
  registerHandler(IPC_CHANNELS.startLogin, async (_event, [provider]) => {
    const done = await core.startLogin(token(provider, 'provider'));
    providersChanged();
    return done;
  });
  registerHandler(IPC_CHANNELS.answerLogin, (_event, [loginId, value]) => {
    core.answerLogin(
      token(loginId, 'loginId'),
      // A question may be answered with nothing ("blank for the default").
      value === null ? null : text(value, 'answer', true),
    );
  });
  registerHandler(IPC_CHANNELS.logoutProvider, async (event, [value]) => {
    const provider = token(value, 'provider');
    const t = translator();
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: t.t('providers.confirmLogout', { id: provider }),
      buttons: [t.t('providers.logout'), t.t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
    };
    const answer =
      window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    return answer.response === 0 ? notifyProviders(await core.logoutProvider(provider)) : null;
  });
  // ADR-0083: turning a provider on or off, checks, and the signed-in accounts.
  registerHandler(IPC_CHANNELS.setProviderEnabled, async (_event, [id, enabled]) =>
    notifyProviders(await core.setProviderEnabled(token(id, 'provider'), flag(enabled, 'enabled'))),
  );
  registerHandler(IPC_CHANNELS.testProvider, (_event, [id]) =>
    core.testProvider(token(id, 'provider')),
  );
  registerHandler(IPC_CHANNELS.discoverModels, (_event, [request, secret]) =>
    core.discoverModels(
      text(request, 'model list request'),
      secret == null ? null : text(secret, 'credential'),
    ),
  );
  registerHandler(IPC_CHANNELS.useProviderAccount, async (_event, [provider, account]) =>
    notifyProviders(
      await core.useProviderAccount(token(provider, 'provider'), token(account, 'account')),
    ),
  );
  registerHandler(IPC_CHANNELS.removeProviderAccount, async (event, [value, accountValue]) => {
    const provider = token(value, 'provider');
    const account = token(accountValue, 'account');
    // The dialog names the account as Core records it, not as the page says.
    const label = accountLabel(await core.providerSettings(), provider, account) ?? account;
    const t = translator();
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: t.t('providers.confirmRemoveAccount', { id: provider, account: label }),
      buttons: [t.t('providers.account.remove'), t.t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
    };
    const answer =
      window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    return answer.response === 0
      ? notifyProviders(await core.removeProviderAccount(provider, account))
      : null;
  });
  registerHandler(IPC_CHANNELS.workspaceModels, (_event, [workspace]) =>
    core.workspaceModels(absolutePath(workspace)),
  );
  registerHandler(IPC_CHANNELS.sessionModels, (_event, [id]) => core.sessionModels(sessionId(id)));
  registerHandler(IPC_CHANNELS.previewModelSwitch, (_event, [id, provider, model]) =>
    core.previewModelSwitch(sessionId(id), token(provider, 'provider'), text(model, 'model')),
  );
  registerHandler(IPC_CHANNELS.setSessionModel, (_event, [id, provider, model, effort]) =>
    core.setSessionModel(
      sessionId(id),
      token(provider, 'provider'),
      text(model, 'model'),
      effort == null ? undefined : token(effort, 'effort'),
    ),
  );
  registerHandler(IPC_CHANNELS.setSessionEffort, (_event, [id, effort]) =>
    core.setSessionEffort(sessionId(id), token(effort, 'effort')),
  );
  registerHandler(IPC_CHANNELS.composerInfo, () => core.composerInfo());
  registerHandler(IPC_CHANNELS.sessionMarkRead, async (_event, [id]) => {
    await core.markSessionRead(sessionId(id));
  });
  registerHandler(IPC_CHANNELS.sessionRename, async (_event, [id, value]) => {
    await core.renameSession(sessionId(id), title(value));
  });
  registerHandler(IPC_CHANNELS.sessionSetPinned, async (_event, [id, pinned]) => {
    await core.setSessionPinned(sessionId(id), flag(pinned, 'pinned'));
  });
  registerHandler(IPC_CHANNELS.sessionDelete, async (event, [id]) => {
    const target = sessionId(id);
    const details: unknown = JSON.parse(await core.sessionDeletionTarget(target));
    if (typeof details !== 'object' || details === null)
      throw new TypeError('invalid deletion target');
    const recorded = 'title' in details && typeof details.title === 'string' ? details.title : '';
    const workspace =
      'workspace' in details && typeof details.workspace === 'string' ? details.workspace : '';
    const name = recorded ? `${recorded} (${target})` : target;
    const t = translator();
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message: t.t('dialog.delete.message', { title: name }),
      detail: [workspace, t.t('dialog.delete.detail')].filter(Boolean).join('\n'),
      buttons: [t.t('dialog.delete.confirm'), t.t('dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } =
      window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
    if (response !== 0) {
      return false;
    }
    await core.deleteSession(target);
    return true;
  });
  registerHandler(IPC_CHANNELS.sessionTranscript, async (_event, [id, start, limit]) => {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer from 1 to 1000');
    }
    if (start !== null && (typeof start !== 'number' || !Number.isInteger(start) || start < 0)) {
      throw new TypeError('start must be a non-negative integer or null');
    }
    const session = sessionId(id);
    await faults.hold(IPC_CHANNELS.sessionTranscript);
    faults.check(IPC_CHANNELS.sessionTranscript);
    return core.transcriptWindow(session, start, limit);
  });
  registerHandler(IPC_CHANNELS.subagentTranscript, (_event, [parent, child, start, limit]) => {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer from 1 to 1000');
    }
    if (start !== null && (typeof start !== 'number' || !Number.isInteger(start) || start < 0)) {
      throw new TypeError('start must be a non-negative integer or null');
    }
    return core.subagentTranscript(sessionId(parent), sessionId(child), start, limit);
  });
  registerHandler(IPC_CHANNELS.subagentStop, (_event, [parent, child]) =>
    core.stopSubagent(sessionId(parent), sessionId(child)),
  );
  registerHandler(IPC_CHANNELS.taskStop, (_event, [id]) => core.stopTask(taskId(id)));
  registerHandler(IPC_CHANNELS.taskOutput, (_event, [id, offset, length]) => {
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError('offset must be a non-negative integer');
    }
    if (
      length !== null &&
      (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > 65536)
    ) {
      throw new TypeError('length must be an integer from 1 to 65536 or null');
    }
    return core.readTaskOutput(taskId(id), offset, length);
  });
  registerHandler(IPC_CHANNELS.agentsList, (_event, [dir]) =>
    core.listAgents(absolutePath(dir), null),
  );
  // Skills, commands and output styles (T37).
  registerHandler(IPC_CHANNELS.commandsList, (_event, [dir, cwd]) =>
    core.listCommands(absolutePath(dir), cwd === null ? null : absolutePath(cwd)),
  );
  registerHandler(IPC_CHANNELS.skillsList, (_event, [dir]) =>
    core.listSkills(absolutePath(dir), null),
  );
  registerHandler(IPC_CHANNELS.outputStyleSet, async (_event, [dir, name]) => {
    if (
      name !== null &&
      (typeof name !== 'string' || name.trim().length === 0 || name.length > 64)
    ) {
      throw new TypeError('name must be an output style name of 1-64 characters or null');
    }
    await core.setOutputStyle(dir === null ? null : absolutePath(dir), name);
  });
  registerHandler(IPC_CHANNELS.webSearchSettings, () => core.webSearchSettings());
  registerHandler(IPC_CHANNELS.managedSettings, () => core.managedSettings());
  registerHandler(IPC_CHANNELS.memoryView, (_event, [dir]) => core.memoryView(absolutePath(dir)));
  registerHandler(IPC_CHANNELS.memoryEdit, (_event, [dir, edit]) => {
    if (typeof edit !== 'string' || edit.length > 64 * 1024) {
      throw new TypeError('edit must be a JSON text of at most 64 KiB');
    }
    return core.memoryEdit(absolutePath(dir), edit);
  });
  registerHandler(IPC_CHANNELS.memoryReveal, async (_event, [dir]) => {
    // The folder Core names for this workspace's repository, never a path from the page.
    const view: unknown = JSON.parse(await core.memoryView(absolutePath(dir)));
    const directory: unknown =
      typeof view === 'object' && view !== null && 'directory' in view ? view.directory : undefined;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw new Error('Core named no memory directory');
    }
    shell.showItemInFolder(directory);
  });
  const backendId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(value)) {
      throw new TypeError('backend must be a search backend id');
    }
    return value;
  };
  registerHandler(IPC_CHANNELS.webSearchBackendSet, async (_event, [backend]) => {
    await core.setWebSearchBackend(backend === null ? null : backendId(backend));
  });
  registerHandler(IPC_CHANNELS.webSearchKeySet, async (_event, [backend, key]) => {
    if (key !== null && (typeof key !== 'string' || key.length === 0 || key.length > 512)) {
      throw new TypeError('key must be an API key of 1-512 characters or null');
    }
    await core.setWebSearchKey(backendId(backend), key);
  });
  registerHandler(IPC_CHANNELS.snapshotsResend, () => {
    core.resendSnapshots();
  });
  registerHandler(IPC_CHANNELS.trustGet, (_event, [dir]) => core.projectTrust(absolutePath(dir)));
  registerHandler(IPC_CHANNELS.trustDecide, (_event, [dir, trusted, version]) => {
    if (typeof version !== 'string' || !/^[0-9a-f]{64}$/u.test(version))
      throw new TypeError('invalid trust view version');
    return core.decideProjectTrust(absolutePath(dir), flag(trusted, 'trusted'), version);
  });
}
