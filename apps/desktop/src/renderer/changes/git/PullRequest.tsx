// The Commit view's pull request band (G5, design addendum P1–P4): the current branch's pull
// request on GitHub through the user's `gh` (number, title, state, checks, review decision, open
// on GitHub, merge with a method), "Create Pull Request" when the branch has commits its base
// lacks, and what to do when `gh` is missing or not signed in. Creating pushes the branch first
// when needed (Core); merging is confirmed natively by the main process.
import { useCallback, useEffect, useId, useState } from 'react';

import { useApp, useT } from '../../app/app-context.js';
import { Button } from '../../app/Button.js';
import type { MergeMethod } from '../../../shared/preferences.js';
import { MERGE_METHODS } from '../../../shared/preferences.js';
import { Dialog } from '../../shell/Dialog.js';
import { ChevronDownIcon, GenerateIcon, PullRequestIcon, SpinnerGlyph } from '../../shell/icons.js';
import { MenuPopup, useMenu } from '../../shell/Menu.js';
import { revealBidi } from '../../transcript/reveal.js';
import { pushNotice, runInTerminal, type GitActions } from './actions.js';
import {
  gitCall,
  prDraftOf,
  pullRequestStatusOf,
  type PullRequest,
  type PullRequestStatus,
  type Repository,
} from './protocol.js';
import { gitSession, newOpId, type GitSnapshot } from './state.js';

/** The last answer per session, so the band does not blink while it asks again. */
const known = new Map<string, PullRequestStatus>();

/** The most characters of a title GitHub keeps here (Core checks the same). */
const TITLE_LIMIT = 256;

/** The base's branch name without its remote (`origin/main` → `main`). */
function baseName(repo: Repository, remotes: readonly string[]): string | undefined {
  const name = repo.base?.name;
  if (name === undefined) return undefined;
  const remote = remotes.find((r) => name.startsWith(`${r}/`));
  return remote === undefined ? name : name.slice(remote.length + 1);
}

export function PullRequestBand({
  sessionId,
  git,
  repo,
  actions,
}: {
  readonly sessionId: string;
  readonly git: GitSnapshot;
  readonly repo: Repository;
  readonly actions: GitActions;
}) {
  const t = useT();
  const [status, setStatus] = useState<PullRequestStatus | undefined>(() => known.get(sessionId));
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    const reply = await gitCall(sessionId, { op: 'pullRequest' }, pullRequestStatusOf);
    if (!reply.ok) return;
    known.set(sessionId, reply.value);
    setStatus(reply.value);
  }, [sessionId]);
  useEffect(() => {
    void load();
  }, [load, repo.branch, repo.head, repo.upstream, repo.ahead, repo.writable]);
  const session = gitSession(sessionId);
  useEffect(() => {
    if (repo.base !== undefined) void session.loadCommits(undefined);
  }, [session, repo.base, repo.head]);
  if (status === undefined) return null;
  if (status.gh === 'unauthenticated') {
    return (
      <div className="git-pr" data-testid="git-pr-signin">
        <PullRequestIcon size={12} />
        <span className="git-pr-text">{t('git.pr.signIn')}</span>
        <button
          type="button"
          className="git-link-button"
          data-testid="git-pr-signin-terminal"
          onClick={() => {
            runInTerminal(sessionId, status.command);
            if (status.command !== undefined) {
              pushNotice(sessionId, {
                tone: 'info',
                text: t('git.notice.commandCopied'),
                actions: [],
              });
            }
          }}
        >
          {t('git.notice.runInTerminal')}
        </button>
      </div>
    );
  }
  if (status.gh === 'missing') {
    return (
      <div className="git-pr is-quiet" data-testid="git-pr-missing">
        <PullRequestIcon size={12} />
        <span className="git-pr-text">{t('git.pr.ghMissing')}</span>
      </div>
    );
  }
  if (status.gh !== 'ready') return null;
  const commits = git.commits.value?.commits.length ?? 0;
  const base = baseName(repo, repo.remotes);
  const canCreate =
    repo.writable &&
    !repo.detached &&
    repo.branch !== undefined &&
    base !== undefined &&
    repo.branch !== base &&
    commits > 0;
  return (
    <>
      {status.pr === undefined ? (
        canCreate ? (
          <div className="git-pr" data-testid="git-pr-none">
            <PullRequestIcon size={12} />
            <span className="git-pr-text">{t('git.pr.none')}</span>
            <Button
              size="small"
              data-testid="git-pr-create"
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('git.pr.create')}
            </Button>
          </div>
        ) : null
      ) : (
        <PullRequestRow
          pr={status.pr}
          writable={repo.writable}
          actions={actions}
          onChanged={() => void load()}
        />
      )}
      {creating && base !== undefined ? (
        <CreatePullRequestDialog
          sessionId={sessionId}
          git={git}
          repo={repo}
          base={base}
          actions={actions}
          onClose={(created) => {
            setCreating(false);
            if (created) void load();
          }}
        />
      ) : null}
    </>
  );
}

function stateLabel(pr: PullRequest, t: ReturnType<typeof useT>): string {
  if (pr.state === 'merged') return t('git.pr.state.merged');
  if (pr.state === 'closed') return t('git.pr.state.closed');
  return pr.draft ? t('git.pr.state.draft') : t('git.pr.state.open');
}

function reviewLabel(decision: string | undefined, t: ReturnType<typeof useT>) {
  switch (decision) {
    case 'APPROVED':
      return t('git.pr.review.approved');
    case 'CHANGES_REQUESTED':
      return t('git.pr.review.changesRequested');
    case 'REVIEW_REQUIRED':
      return t('git.pr.review.required');
    default:
      return undefined;
  }
}

function PullRequestRow({
  pr,
  writable,
  actions,
  onChanged,
}: {
  readonly pr: PullRequest;
  readonly writable: boolean;
  readonly actions: GitActions;
  readonly onChanged: () => void;
}) {
  const { t, preferences } = useApp();
  const menu = useMenu();
  const method = preferences.git.mergeMethod;
  const review = reviewLabel(pr.reviewDecision, t);
  const { passed, failed, pending } = pr.checks;
  const open = pr.state === 'open';
  const why = !writable
    ? t('git.commit.why.untrusted')
    : pr.draft
      ? t('git.pr.draftNoMerge')
      : undefined;
  const merge = async (how: MergeMethod) => {
    const reply = await actions.run(
      { op: 'mergePullRequest', number: pr.number, method: how },
      {
        label: t('git.progress.mergePr', { number: pr.number }),
        done: t('git.notice.prMerged', { number: pr.number }),
      },
    );
    if (reply.ok) onChanged();
  };
  return (
    <div className="git-pr" data-testid="git-pr" data-state={pr.draft ? 'draft' : pr.state}>
      <PullRequestIcon size={12} />
      <button
        type="button"
        className="git-pr-title git-link-button"
        data-testid="git-pr-open"
        data-tooltip={t('git.pr.openOnGithub')}
        onClick={() => void window.piarc.openExternal(pr.url)}
      >
        #{pr.number} {revealBidi(pr.title)}
      </button>
      <span className={`git-pr-state is-${pr.draft && open ? 'draft' : pr.state}`}>
        {stateLabel(pr, t)}
      </span>
      {passed + failed + pending === 0 ? null : (
        <span className="git-pr-checks" data-testid="git-pr-checks">
          {t('git.pr.checks', { passed, failed, pending })}
        </span>
      )}
      {review === undefined ? null : <span className="git-pr-review">{review}</span>}
      {!open ? null : (
        <span className="git-split-button git-pr-merge">
          <Button
            size="small"
            disabled={why !== undefined}
            data-tooltip={why ?? t('git.pr.mergeWith', { method: t(`git.pr.method.${method}`) })}
            data-testid="git-pr-merge"
            onClick={() => void merge(method)}
          >
            {t('git.pr.merge')}
          </Button>
          <button
            type="button"
            className="button button-small git-split-more"
            aria-label={t('git.pr.mergeMethods')}
            aria-haspopup="menu"
            disabled={why !== undefined}
            data-testid="git-pr-merge-more"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              menu.openAt(box.left, box.bottom + 4, event.currentTarget);
            }}
          >
            <ChevronDownIcon size={12} />
          </button>
        </span>
      )}
      {menu.open === null ? null : (
        <MenuPopup
          items={MERGE_METHODS.map((how) => ({
            id: how,
            label: t(`git.pr.method.${how}`),
            selected: how === method,
            testId: `git-pr-merge-${how}`,
            run: () => void merge(how),
          }))}
          at={menu.open}
          onClose={menu.close}
          label={t('git.pr.mergeMethods')}
          testId="git-pr-merge-menu"
        />
      )}
    </div>
  );
}

/** The commit subjects of the branch, newest last, as a starting body. */
function bodyOf(subjects: readonly string[]): string {
  return subjects.length <= 1 ? '' : subjects.map((s) => `- ${s}`).join('\n');
}

function CreatePullRequestDialog({
  sessionId,
  git,
  repo,
  base: inferred,
  actions,
  onClose,
}: {
  readonly sessionId: string;
  readonly git: GitSnapshot;
  readonly repo: Repository;
  readonly base: string;
  readonly actions: GitActions;
  readonly onClose: (created: boolean) => void;
}) {
  const { t, preferences } = useApp();
  const titleId = useId();
  const fieldId = useId();
  const bodyId = useId();
  const baseId = useId();
  const subjects = [...(git.commits.value?.commits ?? [])].reverse().map((c) => c.subject);
  const [title, setTitle] = useState(
    () => (subjects.length === 1 ? subjects[0] : undefined) ?? repo.branch ?? '',
  );
  const [body, setBody] = useState(() => bodyOf(subjects));
  const [base, setBase] = useState(inferred);
  const [draft, setDraft] = useState(preferences.git.draftPullRequests);
  const [generating, setGenerating] = useState<string | undefined>(undefined);
  const [withheld, setWithheld] = useState(0);
  const [creating, setCreating] = useState(false);
  const bases = [
    ...new Set([
      inferred,
      ...(git.branches.value?.remote ?? []).map((b) => b.name).filter((n) => n !== 'HEAD'),
    ]),
  ].filter((name) => name !== repo.branch);
  useEffect(() => {
    void gitSession(sessionId).loadBranches();
  }, [sessionId]);
  const generate = async () => {
    const opId = newOpId();
    setGenerating(opId);
    const instructions =
      preferences.git.prInstructions.trim() === ''
        ? t('git.instructions.prDefault')
        : preferences.git.prInstructions;
    const reply = await gitCall(
      sessionId,
      { op: 'prDescription', instructions, base },
      prDraftOf,
      opId,
    );
    setGenerating(undefined);
    if (reply.ok) {
      setTitle(reply.value.title.slice(0, TITLE_LIMIT));
      setBody(reply.value.body);
      setWithheld(reply.value.withheld.length);
    } else {
      actions.report(reply.failure);
    }
  };
  const problem = title.trim() === '' ? t('git.pr.titleMissing') : undefined;
  const create = async () => {
    if (problem !== undefined || creating) return;
    setCreating(true);
    const reply = await actions.run(
      { op: 'createPullRequest', title: title.trim(), body, base, ...(draft ? { draft } : {}) },
      { label: t('git.progress.createPr') },
    );
    setCreating(false);
    if (!reply.ok) return;
    const url = reply.value.url;
    pushNotice(sessionId, {
      tone: 'info',
      text: t('git.notice.prCreated'),
      actions:
        url === undefined
          ? []
          : [
              {
                label: t('git.pr.openOnGithub'),
                testId: 'git-notice-open-pr',
                run: () => void window.piarc.openExternal(url),
              },
            ],
    });
    onClose(true);
  };
  return (
    <Dialog
      labelledBy={titleId}
      onCancel={() => {
        if (generating !== undefined) void window.piarc.cancelGit(generating);
        onClose(false);
      }}
      testId="git-pr-dialog"
      wide
    >
      <h2 id={titleId} className="dialog-title">
        {t('git.pr.createTitle', { branch: revealBidi(repo.branch ?? '') })}
      </h2>
      <form
        className="git-dialog-form git-pr-form"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <label htmlFor={baseId}>{t('git.pr.base')}</label>
        <select
          id={baseId}
          value={base}
          data-testid="git-pr-base"
          onChange={(event) => {
            setBase(event.target.value);
          }}
        >
          {bases.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="git-pr-field-head">
          <label htmlFor={fieldId}>{t('git.pr.titleField')}</label>
          <Button
            size="small"
            variant="ghost"
            loading={generating !== undefined}
            disabled={generating !== undefined}
            data-testid="git-pr-generate"
            onClick={() => void generate()}
          >
            <GenerateIcon size={12} />
            {t('git.pr.generate')}
          </Button>
        </span>
        <input
          id={fieldId}
          type="text"
          value={title}
          maxLength={TITLE_LIMIT}
          data-autofocus
          aria-invalid={problem !== undefined}
          readOnly={generating !== undefined}
          data-testid="git-pr-title"
          onChange={(event) => {
            setTitle(event.target.value.replace(/[\r\n]+/gu, ' '));
          }}
        />
        <label htmlFor={bodyId}>{t('git.pr.body')}</label>
        <textarea
          id={bodyId}
          className="git-dialog-textarea git-pr-body"
          rows={10}
          value={body}
          maxLength={64 * 1024}
          readOnly={generating !== undefined}
          spellCheck={false}
          data-testid="git-pr-body"
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        {generating === undefined ? null : (
          <p className="git-note" role="status">
            <SpinnerGlyph size={12} /> {t('git.pr.generating')}
          </p>
        )}
        {withheld === 0 ? null : (
          <p className="git-note">{t('git.commit.withheld', { count: withheld })}</p>
        )}
        <label className="git-dialog-check">
          <input
            type="checkbox"
            checked={draft}
            data-testid="git-pr-draft"
            onChange={(event) => {
              setDraft(event.target.checked);
            }}
          />
          {t('git.pr.draft')}
        </label>
        {repo.upstream === undefined || repo.ahead > 0 ? (
          <p className="muted git-pr-push-note">{t('git.pr.pushFirst')}</p>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="button"
            onClick={() => {
              if (generating !== undefined) void window.piarc.cancelGit(generating);
              onClose(false);
            }}
          >
            {t('dialog.cancel')}
          </button>
          <Button
            type="submit"
            variant="primary"
            loading={creating}
            disabled={problem !== undefined || generating !== undefined}
            data-tooltip={problem}
            data-testid="git-pr-submit"
          >
            {draft ? t('git.pr.createDraft') : t('git.pr.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
