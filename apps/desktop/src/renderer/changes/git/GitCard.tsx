// The rail's Git card (SPEC A7.2): in a repository, the branch with ahead and behind and the
// uncommitted files with their line counts; elsewhere the session's own changes as before.
// "Open" shows the Git tool. The status is read when the card first shows and follows the
// panel's refreshes (the same per-session state).
import { useEffect } from 'react';

import { useApp } from '../../app/app-context.js';
import { GitBranchIcon } from '../../shell/icons.js';
import { revealBidi } from '../../transcript/reveal.js';
import { ChangesCard } from '../ChangesPanel.js';
import { openChangesPanel } from '../panel-state.js';
import { useAutoFetch } from './auto-fetch.js';
import { gitSession, useGit } from './state.js';

export function GitCard({ sessionId }: { readonly sessionId: string }) {
  const { t, preferences } = useApp();
  const git = useGit(sessionId);
  useAutoFetch(sessionId, git.status.value?.repository, preferences.git.autoFetch, true);
  useEffect(() => {
    const session = gitSession(sessionId);
    if (session.snapshot().status.value === undefined) void session.refreshStatus();
  }, [sessionId]);
  const status = git.status.value;
  if (status === undefined) {
    return git.status.failure === undefined ? (
      <p className="muted">{t('git.loading')}</p>
    ) : (
      <ChangesCard sessionId={sessionId} />
    );
  }
  const repo = status.repository;
  const added = status.files.reduce((sum, f) => sum + (f.added ?? 0), 0);
  const removed = status.files.reduce((sum, f) => sum + (f.removed ?? 0), 0);
  const branch = repo.detached ? `HEAD ${(repo.head ?? '').slice(0, 7)}` : (repo.branch ?? '');
  return (
    <div className="changes-card git-card" data-testid="git-card">
      <div className="git-card-branch">
        <GitBranchIcon size={12} />
        <span className="git-branch-name">{revealBidi(branch)}</span>
        {repo.upstream === undefined ? null : (
          <span
            className="git-ahead-behind"
            aria-label={t('git.branch.aheadBehind', { ahead: repo.ahead, behind: repo.behind })}
          >
            {repo.ahead > 0 ? `↑${String(repo.ahead)}` : ''}
            {repo.behind > 0 ? ` ↓${String(repo.behind)}` : ''}
          </span>
        )}
      </div>
      {status.files.length === 0 ? (
        <p className="muted">{t('git.card.clean')}</p>
      ) : (
        <div className="changes-head">
          <span className="diff-counts">
            <span className="diff-added">+{added}</span>{' '}
            <span className="diff-removed">−{removed}</span>
          </span>
          <span className="muted">{t('git.card.files', { count: status.files.length })}</span>
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
