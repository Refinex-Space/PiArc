// The session, workspace, trust and composer commands of `window.piarc` (T18, T19): each
// validates its arguments (they come from the renderer) and calls Core. Results are Core's JSON text, passed
// through unread (the renderer validates them). Deleting a session is irreversible, so the
// main process asks the user in a native dialog before it calls Core (architecture section
// 10.3): a page cannot delete a session without the user's click in that dialog.
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';
import { isPermissionMode, type PlanComment, type QuestionAnswer } from '@piarc/protocol';

import {
  type ApprovalAnswer,
  IPC_CHANNELS,
  MAX_ATTACHMENT_IPC_BYTES,
  MAX_PROMPT_LENGTH,
  isSessionId,
} from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type SessionCore = Pick<
  CoreRuntime,
  | 'openWorkspace'
  | 'createSession'
  | 'resumeSession'
  | 'closeSession'
  | 'prompt'
  | 'promptInput'
  | 'steer'
  | 'steerInput'
  | 'followUp'
  | 'followUpInput'
  | 'abort'
  | 'answerApproval'
  | 'setPermissionMode'
  | 'compact'
  | 'editQueueItem'
  | 'deleteQueueItem'
  | 'storeAttachment'
  | 'searchFiles'
  | 'cancelFileSearch'
  | 'providerSettings'
  | 'saveProvider'
  | 'deleteProvider'
  | 'setCatalogRefresh'
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
  if (decision === 'allowAlways') {
    const rules = a.rules === undefined ? [] : ruleList(a.rules);
    if (a.directory === undefined && rules.length === 0) {
      throw new TypeError('always allow needs a rule or directory');
    }
    return {
      ...fields,
      ...(rules.length === 0 ? {} : { rules }),
      ...(a.directory === undefined ? {} : { directory: absolutePath(a.directory) }),
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
  registerHandler(IPC_CHANNELS.sessionCreate, (_event, [workspace, selected]) => {
    const dir = absolutePath(workspace);
    faults.check(IPC_CHANNELS.sessionCreate);
    if (selected == null) return core.createSession(dir, null);
    if (typeof selected !== 'object' || !('provider' in selected) || !('id' in selected)) {
      throw new TypeError('invalid model');
    }
    return core.createSession(dir, {
      model: { provider: token(selected.provider, 'provider'), id: text(selected.id, 'model') },
    });
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
  registerHandler(IPC_CHANNELS.approvalAnswer, async (event, [raw]) => {
    const answer = approvalAnswer(raw);
    if (answer.decision === 'allowAlways') {
      const t = translator();
      const window = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        message: t.t(
          answer.directory === undefined ? 'approval.confirmRule' : 'approval.confirmDirectory',
        ),
        detail: [
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
  registerHandler(IPC_CHANNELS.sessionCompact, (_event, [id]) => core.compact(sessionId(id)));
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
  registerHandler(IPC_CHANNELS.sessionSetArchived, async (_event, [id, archived]) => {
    await core.setSessionArchived(sessionId(id), flag(archived, 'archived'));
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
  registerHandler(IPC_CHANNELS.sessionTranscript, (_event, [id, start, limit]) => {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError('limit must be an integer from 1 to 1000');
    }
    if (start !== null && (typeof start !== 'number' || !Number.isInteger(start) || start < 0)) {
      throw new TypeError('start must be a non-negative integer or null');
    }
    return core.transcriptWindow(sessionId(id), start, limit);
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
