// The new-session flow (architecture section 8.2): the user's message is shown at once with a
// `clientId` → the session is created → the message is sent as its first prompt. A failure at
// any step rolls the optimistic message back and gives the text back to the input; a session
// that was created but did not take its first prompt is closed again (Pi keeps no file for a
// session without a reply, so it leaves no trace).
import type { ModelRef, EffortLevel } from '@piarc/protocol';
import type { PiarcApi, PermissionMode, WorktreeOptions } from '../../shared/ipc.js';
import type { AppStore } from '../store/app-store.js';

import { prepareOutgoing, chipsOf, type Draft } from './session-input.js';

export type StartStep =
  | { readonly kind: 'echo'; readonly clientId: string; readonly text: string }
  | {
      readonly kind: 'created';
      readonly sessionId: string;
      /** The session got a worktree that the repository's `.gitignore` does not cover (T35). */
      readonly unignoredWorktree?: boolean;
    };

/** Whether the create answer names a worktree the repository does not ignore. */
function unignoredWorktree(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || !('worktree' in value)) return false;
    const tree: unknown = value.worktree;
    return typeof tree === 'object' && tree !== null && 'ignored' in tree && tree.ignored === false;
  } catch {
    return false;
  }
}

function field(text: string, name: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && name in value) {
      const found = (value as Record<string, unknown>)[name];
      return typeof found === 'string' ? found : undefined;
    }
  } catch {
    // Not JSON: no field.
  }
  return undefined;
}

/**
 * Starts a session in `workspace` with `text`. `onStep` hears when the echo shows and when the
 * session exists (the view switches to it). Resolves with the session id; rejects after rolling
 * back.
 */
export async function startSession(options: {
  readonly api: Pick<
    PiarcApi,
    | 'createSession'
    | 'prompt'
    | 'closeSession'
    | 'storeAttachment'
    | 'setSessionEffort'
    | 'setPermissionMode'
    | 'setSessionModel'
  >;
  readonly store: AppStore;
  readonly workspace: string;
  /**
   * The draft session the new-session view opened for its tools (ADR-0099): the message goes
   * to it instead of a new session, and it is kept when sending fails.
   */
  readonly sessionId?: string;
  readonly model?: ModelRef;
  /** Run the session in a worktree of its own (T35). */
  readonly worktree?: WorktreeOptions;
  readonly text: string;
  readonly draft?: Draft;
  readonly effort?: EffortLevel;
  readonly mode?: PermissionMode;
  readonly clientId: string;
  readonly watch: (sessionId: string) => () => void;
  readonly onStep: (step: StartStep) => void;
}): Promise<string> {
  const { api, store, workspace, text, clientId } = options;
  options.onStep({ kind: 'echo', clientId, text });
  const existing = options.sessionId;
  const created =
    existing === undefined
      ? await api.createSession(workspace, options.model, options.worktree)
      : JSON.stringify({ sessionId: existing });
  const sessionId = field(created, 'sessionId');
  if (sessionId === undefined) {
    throw new Error('Core did not return a session id');
  }
  const transcript = store.transcript(sessionId);
  const draft = options.draft ?? { text, mentions: [], pending: [], stored: [] };
  transcript.addOptimistic(clientId, {
    text,
    mentions: draft.mentions,
    attachments: chipsOf(draft),
  });
  const unwatch = options.watch(sessionId);
  options.onStep({
    kind: 'created',
    sessionId,
    ...(unignoredWorktree(created) ? { unignoredWorktree: true } : {}),
  });
  try {
    // A draft opened with the default model; the one chosen since applies before the message.
    if (existing !== undefined && options.model !== undefined) {
      await api.setSessionModel(sessionId, options.model.provider, options.model.id);
    }
    if (options.effort !== undefined) await api.setSessionEffort(sessionId, options.effort);
    if (options.mode !== undefined) await api.setPermissionMode(sessionId, options.mode);
    const input = await prepareOutgoing(api, sessionId, clientId, draft);
    const turnId = field(await api.prompt(sessionId, input), 'turnId');
    if (turnId !== undefined) {
      transcript.confirm(clientId, turnId, input.attachments);
    }
    return sessionId;
  } catch (error) {
    transcript.rollback(clientId);
    unwatch();
    // A draft stays for the new-session view (its tools may hold a terminal); a session made
    // for this message goes again.
    if (existing === undefined) {
      api.closeSession(sessionId).catch((closeError: unknown) => {
        console.error('[start] closing the session that did not start failed', closeError);
      });
    }
    throw error;
  }
}
