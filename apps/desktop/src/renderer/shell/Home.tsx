// The main area without a session: pick a folder, describe a task, start. The message appears
// at once (optimistic, with a clientId), then the trust dialog when this is the folder's first
// session, then the session is created and the message sent; a failure rolls the message back
// and puts the text back into the input. T35: the session may run in a worktree of its own (a
// name and a base branch, both optional); a worktree the repository does not ignore yet gets a
// notice offering the `.gitignore` line.
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { isWorktreeName, type WorktreeOptions } from '../../shared/ipc.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useT } from '../app/app-context.js';
import { useStore, useWorkspaces } from '../store/hooks.js';
import { keyOf, useModelCatalog } from './model-catalog.js';
import { reason } from './errors.js';
import { startSession } from './start-session.js';
import { useUi } from './ui.js';

export function Home({
  workspace: requested,
  draft,
  failure,
}: {
  readonly workspace: string | undefined;
  readonly draft: string | undefined;
  readonly failure: string | undefined;
}) {
  const t = useT();
  const ui = useUi();
  const store = useStore();
  const workspaces = useWorkspaces();
  const [workspace, setWorkspace] = useState<string | undefined>(requested);
  const [catalogRequested, setCatalogRequested] = useState<string>();
  const ready = workspaces.some((w) => w.path === workspace && w.open);
  // Listing models starts a Host. Avoid reopening an indexed workspace merely because
  // its name is restored in the home screen after restarting the app.
  const catalogTarget = ready || workspace === catalogRequested ? workspace : undefined;
  const { catalog, failure: catalogFailure } = useModelCatalog(catalogTarget, false);
  const [modelKey, setModelKey] = useState('');
  const model = catalog?.models.find((m) => keyOf(m) === modelKey);
  const [text, setText] = useState(draft ?? '');
  const [echo, setEcho] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(failure);
  const tree = useWorktreeChoice(workspace);
  const busy = echo !== undefined;
  const input = useRef<HTMLTextAreaElement>(null);
  const folderLabel = useId();
  useEffect(() => {
    setWorkspace(requested ?? workspaces[0]?.path);
  }, [requested, workspaces]);
  useEffect(() => {
    input.current?.focus();
  }, [requested]);

  const start = async () => {
    const message = text.trim();
    if (workspace === undefined || message.length === 0 || busy) {
      return;
    }
    setError(undefined);
    if (tree.options === 'invalid') {
      setError(t('home.worktreeInvalidName'));
      return;
    }
    if (!(await ui.ensureTrust(workspace, 'decide'))) {
      return;
    }
    const worktree = tree.options;
    setText('');
    try {
      await startSession({
        api: window.piarc,
        store,
        workspace,
        ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
        ...(worktree === undefined ? {} : { worktree }),
        text: message,
        clientId: crypto.randomUUID(),
        watch: (id) => ui.connection.watchSession(id),
        onStep: (step) => {
          if (step.kind === 'echo') {
            // Shown before Core is asked: the message is on screen at once, even when creating
            // fails right away.
            flushSync(() => {
              setEcho(step.text);
            });
          } else {
            ui.show({ kind: 'session', id: step.sessionId });
            if (step.unignoredWorktree === true) {
              store.addLocalNotice({
                key: `gitignore:${workspace}`,
                type: 'gitignore',
                message: t('notice.gitignore', { workspace }),
                downloadUrl: undefined,
                workspace,
              });
            }
          }
        },
      });
    } catch (cause) {
      // The view may have switched to the new session already: the home view comes back with
      // the text in its input.
      setEcho(undefined);
      ui.show({
        kind: 'home',
        workspace,
        draft: message,
        error: t('home.failed', { reason: reason(cause) }),
      });
    }
  };

  const choices =
    workspaces.some((w) => w.path === workspace) || workspace === undefined
      ? workspaces
      : [...workspaces, { path: workspace, displayName: workspace }];
  return (
    <section className="home" data-testid="home">
      <div className="titlebar main-titlebar" />
      <div className="home-body">
        <h1 className="home-title">{t('home.title')}</h1>
        <div className="field-row">
          <label id={folderLabel} className="field-label">
            {t('home.folder')}
          </label>
          {choices.length > 0 ? (
            <select
              className="input"
              aria-labelledby={folderLabel}
              value={workspace ?? ''}
              data-testid="home-workspace"
              onChange={(event) => {
                setWorkspace(event.currentTarget.value);
              }}
            >
              {choices.map((choice) => (
                <option key={choice.path} value={choice.path}>
                  {choice.displayName}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted">{t('home.noFolder')}</span>
          )}
          <button
            type="button"
            className="button"
            data-testid="home-open-folder"
            onClick={() => {
              void ui.openFolder().then((opened) => {
                if (opened !== undefined) {
                  setWorkspace(opened);
                }
              });
            }}
          >
            {t('home.chooseFolder')}
          </button>
        </div>
        {workspace && (
          <label className="field-row">
            {t('models.label')}
            <select
              className="input"
              data-testid="home-model"
              onFocus={() => {
                setCatalogRequested(workspace);
              }}
              disabled={busy}
              value={model ? keyOf(model) : ''}
              onChange={(e) => {
                setModelKey(e.currentTarget.value);
              }}
            >
              <option value="">{t('models.default')}</option>
              {catalog?.models.map((m) => (
                <option key={keyOf(m)} value={keyOf(m)}>
                  {keyOf(m)}
                </option>
              ))}
            </select>
          </label>
        )}
        {workspace && <WorktreeFields choice={tree} disabled={busy} />}
        {catalogFailure && (
          <p className="error-text" role="alert">
            {t('models.failed', { reason: catalogFailure })}
          </p>
        )}
        {echo !== undefined && (
          <div className="message message-user is-pending" data-testid="optimistic-message">
            <div className="message-author">{t('conversation.you')}</div>
            <div className="message-text">{echo}</div>
            <div className="muted small">{t('home.starting')}</div>
          </div>
        )}
        <textarea
          ref={input}
          className="input prompt-input"
          rows={4}
          placeholder={t('home.placeholder')}
          aria-label={t('home.placeholder')}
          value={text}
          disabled={busy || workspace === undefined}
          data-testid="home-input"
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent)) {
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void start();
            }
          }}
        />
        {error !== undefined && (
          <p className="error-text" role="alert" data-testid="home-error">
            {error}
          </p>
        )}
        <div className="home-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={busy || workspace === undefined || text.trim().length === 0}
            data-testid="home-start"
            onClick={() => {
              void start();
            }}
          >
            {t('home.send')}
          </button>
        </div>
      </div>
    </section>
  );
}

interface WorktreeChoice {
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  readonly name: string;
  readonly setName: (name: string) => void;
  readonly base: string;
  readonly setBase: (base: string) => void;
  /** `undefined` before the answer, `false` outside a repository's top level. */
  readonly branches:
    { readonly current?: string; readonly list: readonly string[] } | false | undefined;
  /** What to send: nothing (no worktree), the options, or `invalid` for a bad name. */
  readonly options: WorktreeOptions | undefined | 'invalid';
}

/** The worktree part of the form; the branches are read when the box is ticked. */
function useWorktreeChoice(workspace: string | undefined): WorktreeChoice {
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [branches, setBranches] = useState<WorktreeChoice['branches']>(undefined);
  useEffect(() => {
    setBranches(undefined);
    setBase('');
    if (!enabled || workspace === undefined) return;
    let active = true;
    window.piarc.worktreeBranches(workspace).then(
      (text) => {
        if (!active) return;
        const value: unknown = JSON.parse(text);
        const answer =
          typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
        if (answer.repository !== true) {
          setBranches(false);
          return;
        }
        const list = Array.isArray(answer.branches)
          ? answer.branches.filter((b: unknown): b is string => typeof b === 'string')
          : [];
        setBranches({
          ...(typeof answer.current === 'string' ? { current: answer.current } : {}),
          list,
        });
      },
      () => {
        if (active) setBranches(false);
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, workspace]);
  const trimmed = name.trim();
  const options: WorktreeChoice['options'] =
    !enabled || branches === false
      ? undefined
      : trimmed.length > 0 && !isWorktreeName(trimmed)
        ? 'invalid'
        : {
            ...(trimmed.length > 0 ? { name: trimmed } : {}),
            ...(base.length > 0 ? { base } : {}),
          };
  return { enabled, setEnabled, name, setName, base, setBase, branches, options };
}

function WorktreeFields({ choice, disabled }: { choice: WorktreeChoice; disabled: boolean }) {
  const t = useT();
  const nameId = useId();
  const baseId = useId();
  const { branches } = choice;
  return (
    <div className="worktree-fields" data-testid="home-worktree-fields">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={choice.enabled}
          disabled={disabled}
          data-testid="home-worktree"
          onChange={(event) => {
            choice.setEnabled(event.currentTarget.checked);
          }}
        />
        {t('home.worktree')}
      </label>
      {choice.enabled && branches === false && (
        <p className="muted small" role="status" data-testid="home-worktree-unavailable">
          {t('home.worktreeNoRepo')}
        </p>
      )}
      {choice.enabled && branches !== false && (
        <div className="field-row">
          <label htmlFor={nameId} className="field-label">
            {t('home.worktreeName')}
          </label>
          <input
            id={nameId}
            className="input"
            value={choice.name}
            disabled={disabled}
            placeholder={t('home.worktreeNameHint')}
            aria-invalid={choice.options === 'invalid'}
            data-testid="home-worktree-name"
            onChange={(event) => {
              choice.setName(event.currentTarget.value);
            }}
          />
          <label htmlFor={baseId} className="field-label">
            {t('home.worktreeBase')}
          </label>
          <select
            id={baseId}
            className="input"
            value={choice.base}
            disabled={disabled || branches === undefined}
            data-testid="home-worktree-base"
            onChange={(event) => {
              choice.setBase(event.currentTarget.value);
            }}
          >
            <option value="">
              {branches?.current === undefined
                ? t('home.worktreeBaseDetached')
                : t('home.worktreeBaseHead', { branch: branches.current })}
            </option>
            {branches?.list
              .filter((branch) => branch !== branches.current)
              .map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
          </select>
        </div>
      )}
    </div>
  );
}
