// The Changes panel and the rail's changes card (T28, architecture section 8.2): the files the
// session changed with its file tools, each against its content before the session first wrote
// it, as a unified diff with line counts and syntax colors. A file or one hunk can be discarded
// (Core puts the recorded content back, or reverts the hunk, after checking the file still is
// what the panel shows). Past the panel's limits the files are folded and a file opened alone
// shows its diff as plain text. Lines take comments that go to the agent together (T42,
// `DiffComments.tsx`).
import type { ChangesFile, ChangesView } from '@piarc/protocol';
import { useState } from 'react';

import { useApp, useT } from '../app/app-context.js';
import { useChanges, useStore, useSession } from '../store/hooks.js';
import { changesOf } from '../store/changes.js';
import { projectPath } from '../files/file-path.js';
import { openProjectFile, projectFileRoot } from '../files/navigation.js';
import { reason } from '../shell/errors.js';
import { useUi } from '../shell/ui.js';
import { isSendKey } from './comments.js';
import { DiffBody } from './DiffBody.js';
import { CommentsBar, DiffCommentsProvider, useDiffCommentsState } from './DiffComments.js';
import { languageOf } from './language.js';
import { openChangesPanel } from './panel-state.js';
import { revealBidi } from '../transcript/reveal.js';
import { Button } from '../app/Button.js';
import { PanelEmpty } from '../shell/PanelEmpty.js';
import { ChangesIcon, ChevronDownIcon, FileIcon } from '../shell/icons.js';

function Counts({ added, removed }: { readonly added: number; readonly removed: number }) {
  return (
    <span className="diff-counts" data-testid="changes-counts">
      <span className="diff-added">+{added}</span> <span className="diff-removed">−{removed}</span>
    </span>
  );
}

/** One file: its header, and its diff when shown. */
function FileRow({
  sessionId,
  root,
  file,
  folded,
  onChanged,
}: {
  readonly sessionId: string;
  readonly root: string;
  readonly file: ChangesFile;
  /** The panel degraded: folded, and the diff fetched alone and shown as plain text. */
  readonly folded: boolean;
  readonly onChanged: (path: string, file: ChangesFile | undefined) => void;
}) {
  const t = useT();
  const { transcriptServices } = useUi();
  const store = useStore();
  const tooLarge = file.diff?.degraded === true;
  const [open, setOpen] = useState(!folded && !tooLarge && file.binary !== true);
  const [alone, setAlone] = useState<ChangesFile | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const shown = alone ?? file;
  const path = projectPath(file.path, root);
  const discard = (hunk: number | undefined) => {
    setBusy(true);
    setFailure(undefined);
    window.piarc
      .discardChange(sessionId, {
        path: shown.path,
        version: shown.version,
        ...(hunk === undefined ? {} : { hunk }),
      })
      .then(
        (text) => {
          const next = changesOf(text).files[0];
          setAlone(undefined);
          onChanged(file.path, next);
        },
        (error: unknown) => {
          setFailure(t('changes.discardFailed', { reason: reason(error) }));
          // The file changed since it was shown: show it as it is now.
          void store
            .transcript(sessionId)
            .changes.refresh(() => window.piarc.sessionChanges(sessionId));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && folded && alone === undefined) {
      window.piarc.sessionChanges(sessionId, file.path).then(
        (text) => {
          setAlone(changesOf(text).files[0]);
        },
        (error: unknown) => {
          setFailure(t('changes.failed', { reason: reason(error) }));
        },
      );
    }
  };
  const diff = shown.diff;
  const plain = folded || tooLarge;
  return (
    <li
      className="changes-file"
      data-testid="changes-file"
      data-path={file.label}
      data-kind={file.kind}
    >
      <div className="changes-file-head">
        <div className="changes-file-title">
          <button
            type="button"
            className="row-action changes-toggle"
            aria-expanded={open}
            aria-label={t('files.tree.toggleDiff', { path: revealBidi(file.label) })}
            data-testid="changes-toggle"
            onClick={toggle}
          >
            <ChevronDownIcon />
          </button>
          <FileIcon />
          {path ? (
            <button
              type="button"
              className="changes-file-path file-path-action"
              data-testid="changes-file-path"
              title={revealBidi(file.path)}
              aria-label={t('files.tree.openPath', { path: revealBidi(file.label) })}
              onClick={() => {
                openProjectFile(sessionId, { path });
              }}
            >
              {revealBidi(file.label)}
            </button>
          ) : (
            <span
              className="changes-file-path"
              title={revealBidi(file.path)}
              data-testid="changes-file-path"
            >
              {revealBidi(file.label)}
            </span>
          )}
        </div>
        <span className="change-tag">{t(`changes.kind.${file.kind}`)}</span>
        <Counts added={file.added} removed={file.removed} />
        <Button
          variant="destructive"
          size="small"
          className="changes-discard-file"
          data-testid="changes-discard-file"
          disabled={busy}
          onClick={() => {
            discard(undefined);
          }}
        >
          {t('changes.discardFile')}
        </Button>
      </div>
      {failure === undefined ? null : (
        <p className="changes-error" role="alert">
          {failure}
        </p>
      )}
      {!open ? null : shown.binary === true ? (
        <p className="muted changes-note">{t('changes.binary')}</p>
      ) : plain ? (
        <>
          {tooLarge ? <p className="muted changes-note">{t('changes.fileDegraded')}</p> : null}
          {diff == null ? null : (
            <pre className="changes-plain" data-testid="changes-plain">
              {diff.unified}
            </pre>
          )}
        </>
      ) : diff == null ? null : (
        <DiffBody
          hunks={diff.hunks}
          language={languageOf(file.label)}
          highlight={transcriptServices.highlight}
          onDiscard={discard}
          busy={busy}
          file={file}
        />
      )}
    </li>
  );
}

function FileList({ sessionId, view }: { readonly sessionId: string; readonly view: ChangesView }) {
  const store = useStore();
  const changes = store.transcript(sessionId).changes;
  const root = projectFileRoot(useSession(sessionId));
  return (
    <ul className="changes-files" data-testid="changes-files">
      {view.files.map((file) => (
        <FileRow
          key={`${file.path}:${file.version}`}
          sessionId={sessionId}
          root={root}
          file={file}
          folded={view.degraded === true}
          onChanged={(path, next) => {
            changes.replaceFile(path, next);
          }}
        />
      ))}
    </ul>
  );
}

/** The dock's Changes panel. */
export function ChangesPanel({ sessionId }: { readonly sessionId: string }) {
  const { t, keyPlatform } = useApp();
  const store = useStore();
  const state = useChanges(sessionId);
  const view = state?.view;
  const comments = useDiffCommentsState(sessionId, view?.files);
  const refresh = () => {
    void store.transcript(sessionId).changes.refresh(() => window.piarc.sessionChanges(sessionId));
  };
  return (
    <DiffCommentsProvider value={comments}>
      <div
        className="changes-panel"
        data-testid="changes-panel"
        aria-busy={state?.loading === true}
        onKeyDown={(event) => {
          if (!isSendKey(event.nativeEvent, keyPlatform)) return;
          event.preventDefault();
          const draft = comments.draft;
          void comments.send(view?.files.find((f) => f.label === draft?.path));
        }}
      >
        <div className="changes-head">
          {view === undefined || view.files.length === 0 ? null : (
            <>
              <Counts added={view.added} removed={view.removed} />
              <span className="muted">{t('changes.files', { count: view.files.length })}</span>
            </>
          )}
          <Button
            size="small"
            variant="ghost"
            className="changes-refresh"
            data-testid="changes-refresh"
            onClick={refresh}
          >
            {t('changes.refresh')}
          </Button>
        </div>
        {state?.failure === undefined ? null : (
          <p className="changes-error" role="alert">
            {t('changes.failed', { reason: state.failure })}
          </p>
        )}
        {view === undefined ? (
          <p className="muted">{t('changes.loading')}</p>
        ) : view.files.length === 0 ? (
          <PanelEmpty
            icon={<ChangesIcon />}
            title={t('changes.none')}
            testId="changes-empty"
            description={<span data-testid="changes-bash-note">{t('changes.bashNote')}</span>}
          />
        ) : (
          <>
            {view.degraded === true ? (
              <p className="changes-note warning-text" data-testid="changes-degraded">
                {t('changes.degraded')}
              </p>
            ) : null}
            <FileList sessionId={sessionId} view={view} />
          </>
        )}
        <CommentsBar />
        {view && view.files.length > 0 && (
          <p className="muted changes-note" data-testid="changes-bash-note">
            {t('changes.bashNote')}
          </p>
        )}
      </div>
    </DiffCommentsProvider>
  );
}

/** The rail's changes card: the totals and the way into the panel. */
export function ChangesCard({ sessionId }: { readonly sessionId: string }) {
  const t = useT();
  const state = useChanges(sessionId);
  const view = state?.view;
  return (
    <div className="changes-card" data-testid="changes-card">
      {view === undefined ? (
        <p className="muted">{t('changes.loading')}</p>
      ) : view.files.length === 0 ? (
        <p className="muted">{t('changes.none')}</p>
      ) : (
        <div className="changes-head">
          <Counts added={view.added} removed={view.removed} />
          <span className="muted">{t('changes.files', { count: view.files.length })}</span>
        </div>
      )}
      <button
        type="button"
        className="button"
        data-testid="changes-open"
        onClick={() => {
          openChangesPanel();
        }}
      >
        {t('changes.open')}
      </button>
    </div>
  );
}
