// The Changes panel's comments on diff lines (T42): the drafts' state for one session (saved in
// localStorage, placed again on every new diff), the editor and the comment rows inside a hunk,
// the panel's send bar and the list of comments whose lines are gone. The message format and the
// placing rules are `comments.ts`.
import type { ChangesFile } from '@piarc/protocol';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { displayKey } from '../../shared/keybindings.js';
import { useApp, useT } from '../app/app-context.js';
import { useTurnInfo } from '../store/hooks.js';
import {
  formatComments,
  isSendKey,
  loadComments,
  reanchor,
  saveComments,
  sideLines,
  type DiffComment,
  type Side,
} from './comments.js';

/** A comment being written or edited. */
export interface CommentDraft {
  /** The comment it edits; absent for a new one. */
  readonly id?: string;
  readonly path: string;
  readonly side: Side;
  readonly start: number;
  readonly end: number;
  readonly body: string;
}

export interface DiffCommentsState {
  readonly comments: readonly DiffComment[];
  readonly draft: CommentDraft | undefined;
  /** Starts a comment on `line` of `side`, or (`extend`) stretches the open draft to it. */
  start(file: ChangesFile, side: Side, line: number, extend: boolean): void;
  edit(id: string): void;
  setBody(body: string): void;
  save(file: ChangesFile | undefined): void;
  cancel(): void;
  remove(id: string): void;
  /**
   * Sends every placed comment, and the one being written (on `file`), as one message; resolves
   * when Core took it.
   */
  send(file?: ChangesFile): Promise<void>;
  readonly sending: boolean;
  readonly failure: string | undefined;
}

const Context = createContext<DiffCommentsState | undefined>(undefined);

export const DiffCommentsProvider = Context.Provider;

/** The comments of the panel this hunk belongs to (none outside a panel). */
export function useDiffComments(): DiffCommentsState | undefined {
  return useContext(Context);
}

/** `comments` with `draft` saved: an edited body, or a new comment on `file`. */
function withDraft(
  comments: readonly DiffComment[],
  draft: CommentDraft,
  file: ChangesFile | undefined,
): DiffComment[] {
  const body = draft.body;
  if (draft.id !== undefined) {
    const id = draft.id;
    return comments.map((c) => (c.id === id ? { ...c, body } : c));
  }
  if (file === undefined) return [...comments];
  const lines = sideLines(file, draft.side);
  const excerpt: string[] = [];
  for (let n = draft.start; n <= draft.end; n += 1) excerpt.push(lines.get(n) ?? '');
  return [
    ...comments,
    {
      id: newId(),
      path: draft.path,
      side: draft.side,
      start: draft.start,
      end: draft.end,
      excerpt,
      body,
    },
  ];
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** The comments of session `sessionId`, placed on `files`. */
export function useDiffCommentsState(
  sessionId: string,
  files: readonly ChangesFile[] | undefined,
): DiffCommentsState {
  const turn = useTurnInfo(sessionId);
  const [comments, setComments] = useState<DiffComment[]>(() => loadComments(sessionId));
  const [draft, setDraft] = useState<CommentDraft | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  // A new diff: place every comment again.
  useEffect(() => {
    if (files === undefined) return;
    setComments((current) => reanchor(current, files));
  }, [files]);
  useEffect(() => {
    saveComments(sessionId, comments);
  }, [sessionId, comments]);
  const start = useCallback((file: ChangesFile, side: Side, line: number, extend: boolean) => {
    setDraft((current) => {
      if (
        extend &&
        current !== undefined &&
        current.id === undefined &&
        current.path === file.label &&
        current.side === side
      ) {
        return {
          ...current,
          start: Math.min(current.start, line),
          end: Math.max(current.end, line),
        };
      }
      return { path: file.label, side, start: line, end: line, body: '' };
    });
  }, []);
  const edit = useCallback(
    (id: string) => {
      const c = comments.find((x) => x.id === id);
      if (c !== undefined) {
        setDraft({ id, path: c.path, side: c.side, start: c.start, end: c.end, body: c.body });
      }
    },
    [comments],
  );
  const save = useCallback(
    (file: ChangesFile | undefined) => {
      if (draft === undefined || draft.body.trim() === '') return;
      setComments((current) => withDraft(current, draft, file));
      setDraft(undefined);
    },
    [draft],
  );
  const send = useCallback(
    async (file?: ChangesFile) => {
      // Mod+Enter in the editor keeps the comment being written and sends it with the others.
      const all =
        draft !== undefined && draft.body.trim() !== ''
          ? withDraft(comments, draft, file)
          : comments;
      if (all !== comments) {
        setComments(all);
        setDraft(undefined);
      }
      const live = all.filter((c) => c.stale !== true);
      if (live.length === 0 || sending) return;
      setSending(true);
      setFailure(undefined);
      try {
        const text = formatComments(live);
        // While the agent works, the message waits in the queue (the composer's Mod+Enter).
        await (turn.running
          ? window.piarc.followUp(sessionId, text)
          : window.piarc.prompt(sessionId, text));
        const sent = new Set(live.map((c) => c.id));
        setComments((current) => current.filter((c) => !sent.has(c.id)));
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setSending(false);
      }
    },
    [comments, draft, sending, sessionId, turn.running],
  );
  return useMemo(
    () => ({
      comments,
      draft,
      start,
      edit,
      setBody: (body: string) => {
        setDraft((current) => (current === undefined ? current : { ...current, body }));
      },
      save,
      cancel: () => {
        setDraft(undefined);
      },
      remove: (id: string) => {
        setComments((current) => current.filter((c) => c.id !== id));
      },
      send,
      sending,
      failure,
    }),
    [comments, draft, start, edit, save, send, sending, failure],
  );
}

/** The editor of the open draft, inside a hunk's table. */
export function CommentEditorRow({ file }: { readonly file: ChangesFile }) {
  const { t, keyPlatform } = useApp();
  const state = useDiffComments();
  const draft = state?.draft;
  if (state === undefined || draft === undefined) return null;
  const range =
    draft.start === draft.end
      ? t('changes.comment.line', { line: draft.start })
      : t('changes.comment.lines', { start: draft.start, end: draft.end });
  return (
    <tr className="diff-comment-editor" data-testid="changes-comment-editor">
      <td colSpan={3}>
        <form
          className="diff-comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            state.save(file);
          }}
        >
          <label className="muted small" htmlFor="changes-comment-text">
            {range} · {t(draft.side === 'new' ? 'changes.comment.new' : 'changes.comment.old')}
          </label>
          <textarea
            id="changes-comment-text"
            className="input diff-comment-input"
            data-testid="changes-comment-input"
            rows={3}
            autoFocus
            value={draft.body}
            onChange={(event) => {
              state.setBody(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (isSendKey(event.nativeEvent, keyPlatform)) {
                event.preventDefault();
                event.stopPropagation();
                void state.send(file);
                return;
              }
              if (event.key === 'Escape') {
                event.stopPropagation();
                state.cancel();
              }
            }}
          />
          <div className="diff-comment-actions">
            <button
              type="submit"
              className="button button-small button-primary"
              data-testid="changes-comment-save"
              disabled={draft.body.trim() === ''}
            >
              {t('changes.comment.save')}
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                state.cancel();
              }}
            >
              {t('changes.comment.cancel')}
            </button>
          </div>
        </form>
      </td>
    </tr>
  );
}

/** A saved comment under its last line. */
export function CommentRow({ comment }: { readonly comment: DiffComment }) {
  const t = useT();
  const state = useDiffComments();
  if (state === undefined) return null;
  return (
    <tr className="diff-comment" data-testid="changes-comment" data-comment={comment.id}>
      <td colSpan={3}>
        <div className="diff-comment-body">
          <span className="muted small">
            {comment.start === comment.end
              ? t('changes.comment.line', { line: comment.start })
              : t('changes.comment.lines', { start: comment.start, end: comment.end })}{' '}
            · {t(comment.side === 'new' ? 'changes.comment.new' : 'changes.comment.old')}
          </span>
          <p data-testid="changes-comment-text">{comment.body}</p>
          <div className="diff-comment-actions">
            <button
              type="button"
              className="button button-small"
              data-testid="changes-comment-edit"
              onClick={() => {
                state.edit(comment.id);
              }}
            >
              {t('changes.comment.edit')}
            </button>
            <button
              type="button"
              className="button button-small"
              data-testid="changes-comment-delete"
              onClick={() => {
                state.remove(comment.id);
              }}
            >
              {t('changes.comment.delete')}
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

/** The panel's bar: how many comments, Send (Mod+Enter), and the comments whose lines are gone. */
export function CommentsBar() {
  const { t, keyPlatform } = useApp();
  const state = useDiffComments();
  if (state === undefined) return null;
  const live = state.comments.filter((c) => c.stale !== true);
  const stale = state.comments.filter((c) => c.stale === true);
  if (state.comments.length === 0) return null;
  return (
    <div className="diff-comments-bar" data-testid="changes-comments-bar">
      {live.length === 0 ? null : (
        <div className="diff-comments-send">
          <span className="muted" data-testid="changes-comments-count">
            {t('changes.comment.count', { count: live.length })}
          </span>
          <button
            type="button"
            className="button button-small button-primary"
            data-testid="changes-comments-send"
            disabled={state.sending}
            onClick={() => {
              void state.send();
            }}
          >
            {t('changes.comment.send')}
          </button>
          <span className="muted small">
            {t('changes.comment.sendHint', { key: displayKey('Mod+Enter', keyPlatform) })}
          </span>
        </div>
      )}
      {state.failure === undefined ? null : (
        <p className="changes-error" role="alert">
          {t('changes.comment.failed', { reason: state.failure })}
        </p>
      )}
      {stale.length === 0 ? null : (
        <ul className="diff-comments-stale" data-testid="changes-comments-stale">
          {stale.map((c) => (
            <li key={c.id} data-testid="changes-comment-stale">
              <span className="change-tag">{t('changes.comment.stale')}</span>{' '}
              <span className="muted small">
                {c.path}:{c.start}
              </span>{' '}
              <span>{c.body}</span>{' '}
              <button
                type="button"
                className="button button-small"
                onClick={() => {
                  state.remove(c.id);
                }}
              >
                {t('changes.comment.delete')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
