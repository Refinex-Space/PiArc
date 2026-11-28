// Settings › Agents › Instructions (ADR-0108): Pi's global instructions in `~/.pi/agent`, the file
// Pi loads before any project file and Core puts first among the user's memory documents. The
// page shows it and saves edits; Core refuses a save over a file that changed since it was read
// (an edit in Pi's own CLI or an editor), and the page then offers to load it again.
import { useCallback, useEffect, useId, useState } from 'react';

import { Button } from '../app/Button.js';
import { useApp } from '../app/app-context.js';
import { failureKind, reason } from '../shell/errors.js';
import { SettingsSection } from './layout.js';

export interface InstructionsView {
  readonly path: string;
  readonly exists: boolean;
  readonly content: string;
  readonly hash: string | null;
}

/** Core's answer, checked. */
export function parseInstructions(raw: string): InstructionsView {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('path' in value) ||
    !('exists' in value) ||
    !('content' in value) ||
    typeof value.path !== 'string' ||
    typeof value.exists !== 'boolean' ||
    typeof value.content !== 'string'
  ) {
    throw new Error('Invalid instructions');
  }
  const hash = 'hash' in value && typeof value.hash === 'string' ? value.hash : null;
  return { path: value.path, exists: value.exists, content: value.content, hash };
}

/** The file's name, the section's title. */
function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}

/** Textareas give LF; the file keeps its own line endings (Core writes them back). */
function sameText(a: string, b: string): boolean {
  return a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');
}

export function InstructionsPage() {
  const { t } = useApp();
  const editorId = useId();
  const statusId = useId();
  const [view, setView] = useState<InstructionsView>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [saved, setSaved] = useState(false);

  const show = useCallback((next: InstructionsView) => {
    setView(next);
    setText(next.content.replaceAll('\r\n', '\n'));
    setError('');
    setStale(false);
  }, []);

  const load = useCallback(() => {
    window.piarc
      .piInstructions()
      .then((raw) => {
        show(parseInstructions(raw));
      })
      .catch((e: unknown) => {
        setError(reason(e));
      });
  }, [show]);
  useEffect(load, [load]);

  const dirty = view !== undefined && !sameText(text, view.content);
  const save = () => {
    if (view === undefined) return;
    setBusy(true);
    setSaved(false);
    window.piarc
      .savePiInstructions(text, view.hash)
      .then((raw) => {
        show(parseInstructions(raw));
        setSaved(true);
      })
      .catch((e: unknown) => {
        setError(reason(e));
        setStale(failureKind(e) === 'fileModified');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="instructions-page" data-testid="instructions-page">
      <SettingsSection
        title={view === undefined ? t('instructions.editor') : fileName(view.path)}
        testId="instructions-section"
      >
        {view === undefined ? (
          error === '' ? (
            <p className="muted" role="status">
              {t('instructions.loading')}
            </p>
          ) : null
        ) : (
          <form
            className="instructions-editor"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <p className="instructions-path muted small" data-testid="instructions-path">
              <span className="instructions-file">{view.path}</span>
              {view.exists ? null : <span> · {t('instructions.createdOnSave')}</span>}
            </p>
            <textarea
              id={editorId}
              className="input instructions-input"
              aria-label={t('instructions.editor')}
              aria-describedby={statusId}
              placeholder={t('instructions.placeholder')}
              spellCheck={false}
              rows={18}
              value={text}
              data-testid="instructions-editor"
              onChange={(e) => {
                setText(e.currentTarget.value);
                setSaved(false);
              }}
            />
            <div className="instructions-actions">
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={!dirty || busy}
                data-testid="instructions-save"
              >
                {t('instructions.save')}
              </Button>
              <Button
                variant="ghost"
                disabled={!dirty || busy}
                data-testid="instructions-discard"
                onClick={() => {
                  setText(view.content.replaceAll('\r\n', '\n'));
                  setError('');
                }}
              >
                {t('instructions.discard')}
              </Button>
              <span id={statusId} className="instructions-status muted small" role="status">
                {saved && !dirty ? t('instructions.saved') : ''}
              </span>
            </div>
          </form>
        )}
        {error === '' ? null : (
          <div className="instructions-error" role="alert" data-testid="instructions-error">
            <p className="error-text small">{error}</p>
            {stale ? (
              <Button size="small" data-testid="instructions-reload" onClick={load}>
                {t('instructions.reload')}
              </Button>
            ) : null}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
