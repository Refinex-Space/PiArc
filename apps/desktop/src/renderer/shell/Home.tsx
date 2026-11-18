// The main area without a session: pick a folder, describe a task, start. The message appears
// at once (optimistic, with a clientId), then the trust dialog when this is the folder's first
// session, then the session is created and the message sent; a failure rolls the message back
// and puts the text back into the input.
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { isImeComposing } from '../composer/ime-guard.js';
import { useT } from '../app/app-context.js';
import { useStore, useWorkspaces } from '../store/hooks.js';
import { startSession } from './start-session.js';
import { useUi } from './ui.js';

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // `ipcRenderer.invoke` prefixes "Error invoking remote method '<channel>': Error: ".
  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}

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
  const [text, setText] = useState(draft ?? '');
  const [echo, setEcho] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(failure);
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
    if (!(await ui.ensureTrust(workspace, 'decide'))) {
      return;
    }
    setText('');
    try {
      await startSession({
        api: window.piarc,
        store,
        workspace,
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
