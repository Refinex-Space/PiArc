// The log view's details (design addendum H1.5, H3.2): one commit in full, or one stash, with
// its changed files in the same file sections as the changes view (the commit against its first
// parent; a stash's untracked part is not shown and the pane says so).
import { useEffect, useMemo, useState } from 'react';

import { useApp, useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { useUi } from '../../shell/ui.js';
import { MoreIcon } from '../../shell/icons.js';
import { revealBidi } from '../../transcript/reveal.js';
import { FileSection, type DiffDisplay } from './GitDiff.js';
import { shortId } from './history-actions.js';
import type { ScopeChoice } from './model.js';
import {
  commitDetailOf,
  gitCall,
  type CommitDetail,
  type LogCommit,
  type RefLabel,
  type StashEntry,
} from './protocol.js';
import { gitSession, useGit } from './state.js';

/** Files open at first when the commit changes fewer lines than this. */
const OPEN_LINES = 2000;

function Refs({ refs }: { readonly refs: readonly RefLabel[] }) {
  if (refs.length === 0) return null;
  return (
    <span className="git-detail-refs">
      {refs.map((label) => (
        <span
          key={`${label.kind}:${label.name}`}
          className={`git-ref is-${label.kind}${label.current === true ? ' is-current' : ''}`}
        >
          {revealBidi(label.name)}
        </span>
      ))}
    </span>
  );
}

/** The changed files of `sha` against its first parent, as file sections. */
function CommitFiles({
  sessionId,
  choice,
  display,
}: {
  readonly sessionId: string;
  readonly choice: Extract<ScopeChoice, { kind: 'commit' }>;
  readonly display: DiffDisplay;
}) {
  const t = useT();
  const { transcriptServices } = useUi();
  useGit(sessionId);
  const session = gitSession(sessionId);
  const load = session.changes(choice, display.hideWhitespace);
  useEffect(() => {
    void session.loadChanges(choice, display.hideWhitespace);
  }, [session, choice, display.hideWhitespace, load.stale]);
  const changes = load.value;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (changes === undefined) return;
    const small = !changes.withheld && changes.added + changes.removed < OPEN_LINES;
    setOpen(small ? new Set(changes.files.map((f) => f.path)) : new Set());
  }, [changes]);
  if (changes === undefined) {
    return load.failure === undefined ? (
      <p className="git-note">{t('git.diff.loading')}</p>
    ) : (
      <p className="git-note" role="alert">
        {t('git.log.failed')}
      </p>
    );
  }
  return (
    <div className="git-detail-files" data-testid="git-detail-files">
      <p className="git-detail-count">
        {t('git.log.files', { count: changes.files.length })}
        <span className="diff-added"> +{changes.added}</span>
        <span className="diff-removed"> −{changes.removed}</span>
      </p>
      {changes.files.map((file) => (
        <FileSection
          key={file.path}
          sessionId={sessionId}
          file={file}
          scope={{ kind: 'commit', sha: choice.sha }}
          display={display}
          open={open.has(file.path)}
          current={false}
          highlight={transcriptServices.highlight}
          onToggle={() => {
            setOpen((old) => {
              const next = new Set(old);
              if (next.has(file.path)) next.delete(file.path);
              else next.add(file.path);
              return next;
            });
          }}
          onOpenFile={undefined}
          onMenu={() => undefined}
        />
      ))}
    </div>
  );
}

export function CommitDetailPane({
  sessionId,
  commit,
  display,
  onSelect,
  onMenu,
}: {
  readonly sessionId: string;
  readonly commit: LogCommit;
  readonly display: DiffDisplay;
  readonly onSelect: (sha: string) => void;
  readonly onMenu: (x: number, y: number) => void;
}) {
  const { t, format } = useApp();
  const [detail, setDetail] = useState<CommitDetail | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setDetail(undefined);
    void gitCall(sessionId, { op: 'commitDetail', sha: commit.sha }, commitDetailOf).then(
      (reply) => {
        if (live && reply.ok) setDetail(reply.value);
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, commit.sha]);
  const choice = useMemo(
    () =>
      ({
        kind: 'commit',
        sha: commit.sha,
        short: shortId(commit.sha),
        subject: commit.subject,
      }) as const,
    [commit.sha, commit.subject],
  );
  const message = detail?.message ?? commit.subject;
  const newline = message.indexOf('\n');
  const body = newline === -1 ? '' : message.slice(newline + 1).trim();
  const authored = format.dateTime((detail?.authorTime ?? commit.time) * 1000);
  const committedBySomeoneElse =
    detail !== undefined &&
    (detail.committer !== detail.author || detail.committerEmail !== detail.authorEmail);
  return (
    <article
      className="git-detail"
      aria-label={t('git.log.detail')}
      data-testid="git-commit-detail"
    >
      <header className="git-detail-head">
        <h2 className="git-detail-subject">
          {revealBidi(commit.subject === '' ? t('git.commits.noMessage') : commit.subject)}
        </h2>
        <IconButton
          label={t('git.log.actions')}
          size="sm"
          data-testid="git-detail-menu"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onMenu(box.left, box.bottom + 4);
          }}
        >
          <MoreIcon />
        </IconButton>
      </header>
      <Refs refs={detail?.refs ?? commit.refs} />
      <dl className="git-detail-meta">
        <dt>{t('git.log.commit')}</dt>
        <dd>
          <button
            type="button"
            className="git-link-button git-detail-sha"
            data-tooltip={t('git.log.copy')}
            onClick={() => void navigator.clipboard.writeText(commit.sha)}
          >
            {commit.sha}
          </button>
        </dd>
        <dt>{t('git.log.author')}</dt>
        <dd>
          {revealBidi(commit.author)}
          {commit.email === '' ? '' : ` <${revealBidi(commit.email)}>`}
          {' · '}
          {authored}
        </dd>
        {committedBySomeoneElse ? (
          <>
            <dt>{t('git.log.committer')}</dt>
            <dd>
              {revealBidi(detail.committer)} · {format.dateTime(detail.commitTime * 1000)}
            </dd>
          </>
        ) : null}
        {commit.parents.length === 0 ? null : (
          <>
            <dt>{t('git.log.parents', { count: commit.parents.length })}</dt>
            <dd className="git-detail-parents">
              {commit.parents.map((parent) => (
                <button
                  key={parent}
                  type="button"
                  className="git-link-button"
                  data-testid="git-detail-parent"
                  onClick={() => {
                    onSelect(parent);
                  }}
                >
                  {shortId(parent)}
                </button>
              ))}
            </dd>
          </>
        )}
      </dl>
      {body === '' ? null : <pre className="git-detail-body">{revealBidi(body)}</pre>}
      <CommitFiles sessionId={sessionId} choice={choice} display={display} />
    </article>
  );
}

export function StashDetailPane({
  sessionId,
  entry,
  display,
  writable,
  onApply,
  onBranch,
  onDrop,
}: {
  readonly sessionId: string;
  readonly entry: StashEntry;
  readonly display: DiffDisplay;
  readonly writable: boolean;
  readonly onApply: (pop: boolean) => void;
  readonly onBranch: () => void;
  readonly onDrop: () => void;
}) {
  const { t, format } = useApp();
  const choice = useMemo(
    () =>
      ({
        kind: 'commit',
        sha: entry.oid,
        short: shortId(entry.oid),
        subject: entry.message,
      }) as const,
    [entry.oid, entry.message],
  );
  const why = writable ? undefined : t('git.log.untrusted');
  return (
    <article
      className="git-detail"
      aria-label={t('git.log.stashDetail')}
      data-testid="git-stash-detail"
    >
      <header className="git-detail-head">
        <h2 className="git-detail-subject">
          {revealBidi(entry.message === '' ? t('git.commits.noMessage') : entry.message)}
        </h2>
      </header>
      <p className="git-detail-line">
        {`stash@{${String(entry.index)}}`}
        {entry.branch === undefined ? '' : ` · ${revealBidi(entry.branch)}`}
        {' · '}
        {format.dateTime(entry.time * 1000)}
      </p>
      <div className="git-detail-actions">
        <button
          type="button"
          className="button button-small"
          disabled={!writable}
          data-tooltip={why}
          data-testid="git-stash-apply"
          onClick={() => {
            onApply(false);
          }}
        >
          {t('git.stash.apply')}
        </button>
        <button
          type="button"
          className="button button-small"
          disabled={!writable}
          data-tooltip={why}
          data-testid="git-stash-pop"
          onClick={() => {
            onApply(true);
          }}
        >
          {t('git.stash.pop')}
        </button>
        <button
          type="button"
          className="button button-small"
          disabled={!writable}
          data-tooltip={why}
          data-testid="git-stash-branch"
          onClick={onBranch}
        >
          {t('git.stash.branch')}
        </button>
        <button
          type="button"
          className="button button-small button-destructive"
          disabled={!writable}
          data-tooltip={why}
          data-testid="git-stash-drop"
          onClick={onDrop}
        >
          {t('git.stash.drop')}
        </button>
      </div>
      <p className="muted git-note">{t('git.stash.untrackedNote')}</p>
      <CommitFiles sessionId={sessionId} choice={choice} display={display} />
    </article>
  );
}
