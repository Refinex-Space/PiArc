// AI review in the Changes view (ADR-0087, design addendum V1): the header's "Review" button,
// the bar above the diff (summary, count, previous and next, "Ask the agent to fix", clear,
// "may be outdated"), and the findings either under their lines in the diff ("inline") or as a
// list grouped by file ("separate"), per the setting `git.reviewPresentation`. Core already
// dropped findings whose file or line was not in the diff it sent.
import type { DiffHunk } from '@piarc/protocol';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { useApp, useT } from '../../app/app-context.js';
import { Button } from '../../app/Button.js';
import { IconButton } from '../../app/IconButton.js';
import { reason } from '../../shell/errors.js';
import {
  CaretDownGlyph,
  CaretUpGlyph,
  ReviewIcon,
  SpinnerGlyph,
  StopGlyph,
} from '../../shell/icons.js';
import { useTurnInfo } from '../../store/hooks.js';
import { revealBidi } from '../../transcript/reveal.js';
import { pushNotice, useGitActions } from './actions.js';
import { gitScope, scopeKey, type ScopeChoice } from './model.js';
import { gitCall, reviewOf, type FileChange, type Finding, type Review } from './protocol.js';
import {
  changesKeyOf,
  clearReview,
  dismissFinding,
  findingId,
  formatFindings,
  setReviewRunning,
  shownFindings,
  shownLines,
  storeReview,
  useReviews,
} from './review.js';
import { newOpId } from './state.js';

/** Findings shown under their lines, and how to dismiss one. */
interface InlineFindings {
  readonly findings: readonly Finding[];
  readonly dismiss: (id: string) => void;
}

const InlineContext = createContext<InlineFindings | undefined>(undefined);

/** The model-facing heading of the message that hands findings to the agent. */
function reviewHeading(review: Review): string {
  if (review.scope.kind === 'uncommitted')
    return 'Code review findings on the uncommitted changes:';
  if (review.scope.kind === 'branch' && review.scope.base !== undefined) {
    return `Code review findings on the changes since ${review.scope.base}:`;
  }
  return 'Code review findings on the changes:';
}

function reviewable(scope: ScopeChoice): boolean {
  return scope.kind === 'branch' || scope.kind === 'uncommitted';
}

/** The header's "Review" button (and "Stop" while a review is being written). */
export function ReviewButton({
  sessionId,
  scope,
  files,
  writable,
}: {
  readonly sessionId: string;
  readonly scope: ScopeChoice;
  readonly files: readonly FileChange[] | undefined;
  readonly writable: boolean;
}) {
  const t = useT();
  const actions = useGitActions(sessionId);
  const { running } = useReviews(sessionId);
  if (running !== undefined) {
    return (
      <IconButton
        label={t('git.review.stop')}
        data-testid="git-review-stop"
        onClick={() => {
          void window.piarc.cancelGit(running.opId);
          setReviewRunning(sessionId, undefined);
        }}
      >
        <StopGlyph />
      </IconButton>
    );
  }
  const why = !reviewable(scope)
    ? t('git.review.why.scope')
    : !writable
      ? t('git.commit.why.untrusted')
      : files === undefined || files.length === 0
        ? t('git.review.why.empty')
        : undefined;
  const start = async () => {
    const request = gitScope(scope);
    if (request === undefined || files === undefined) return;
    const opId = newOpId();
    const key = scopeKey(scope);
    const changesKey = changesKeyOf(files);
    setReviewRunning(sessionId, { opId, scopeKey: key });
    const reply = await gitCall(sessionId, { op: 'review', scope: request }, reviewOf, opId);
    setReviewRunning(sessionId, undefined);
    if (reply.ok) storeReview(sessionId, key, reply.value, changesKey);
    else actions.report(reply.failure);
  };
  return (
    <IconButton
      label={why ?? t('git.review.start')}
      disabled={why !== undefined}
      data-testid="git-review"
      onClick={() => void start()}
    >
      <ReviewIcon />
    </IconButton>
  );
}

function SeverityTag({ finding }: { readonly finding: Finding }) {
  const t = useT();
  return (
    <span className={`git-severity is-${finding.severity}`} data-severity={finding.severity}>
      {t(`git.review.severity.${finding.severity}`)}
    </span>
  );
}

/** One finding: severity, title, line, explanation and "Dismiss". */
function FindingCard({
  finding,
  onDismiss,
  onPick,
}: {
  readonly finding: Finding;
  readonly onDismiss: () => void;
  /** Present in the separate list: shows the finding's line in the diff. */
  readonly onPick?: (() => void) | undefined;
}) {
  const t = useT();
  const title = revealBidi(finding.title);
  return (
    <div className="git-finding-body">
      <div className="git-finding-head">
        <SeverityTag finding={finding} />
        {onPick === undefined ? (
          <strong className="git-finding-title">{title}</strong>
        ) : (
          <button
            type="button"
            className="git-finding-title git-link-button"
            data-testid="git-finding-pick"
            onClick={onPick}
          >
            {title}
          </button>
        )}
        <span className="git-finding-line">{t('git.review.line', { line: finding.line })}</span>
        <span className="git-finding-spacer" />
        <button
          type="button"
          className="git-link-button"
          data-testid="git-finding-dismiss"
          aria-label={t('git.review.dismissFinding', { title })}
          onClick={onDismiss}
        >
          {t('git.review.dismiss')}
        </button>
      </div>
      {finding.body === '' ? null : <p className="git-finding-text">{revealBidi(finding.body)}</p>}
    </div>
  );
}

/** Inline findings on line `now` of `path`, as table rows under it. */
export function FindingsBelow({
  path,
  now,
  span,
}: {
  readonly path: string;
  readonly now: number | undefined;
  readonly span: number;
}) {
  const inline = useContext(InlineContext);
  if (inline === undefined || now === undefined) return null;
  return (
    <>
      {inline.findings
        .filter((f) => f.path === path && f.line === now)
        .map((f) => {
          const id = findingId(f);
          return (
            <tr key={id} className="git-finding" data-testid="git-finding" data-finding={id}>
              <td colSpan={span}>
                <FindingCard
                  finding={f}
                  onDismiss={() => {
                    inline.dismiss(id);
                  }}
                />
              </td>
            </tr>
          );
        })}
    </>
  );
}

/** Inline findings of `path` on lines its hunks do not show, above its diff. */
export function FileFindings({
  path,
  hunks,
}: {
  readonly path: string;
  readonly hunks: readonly DiffHunk[];
}) {
  const inline = useContext(InlineContext);
  const lines = useMemo(() => shownLines(hunks), [hunks]);
  if (inline === undefined) return null;
  const outside = inline.findings.filter((f) => f.path === path && !lines.has(f.line));
  if (outside.length === 0) return null;
  return (
    <div className="git-finding-block">
      {outside.map((f) => {
        const id = findingId(f);
        return (
          <div key={id} className="git-finding" data-testid="git-finding" data-finding={id}>
            <FindingCard
              finding={f}
              onDismiss={() => {
                inline.dismiss(id);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The review of the current scope: its bar above the diff, and for inline presentation the
 * provider the diff's rows read. `onReveal` opens a file and scrolls to a line or a finding.
 */
export function ReviewArea({
  sessionId,
  scope,
  files,
  onReveal,
  children,
}: {
  readonly sessionId: string;
  readonly scope: ScopeChoice;
  readonly files: readonly FileChange[];
  readonly onReveal: (path: string, line: number, findingId?: string) => void;
  readonly children: ReactNode;
}) {
  const { t, preferences } = useApp();
  const { records, running } = useReviews(sessionId);
  const key = scopeKey(scope);
  const record = records.get(key);
  const findings = useMemo(() => shownFindings(record), [record]);
  const inline = preferences.git.reviewPresentation === 'inline';
  const value = useMemo<InlineFindings | undefined>(
    () =>
      inline && record !== undefined
        ? {
            findings,
            dismiss: (id) => {
              dismissFinding(sessionId, key, id);
            },
          }
        : undefined,
    [inline, record, findings, sessionId, key],
  );
  const bar =
    running?.scopeKey === key ? (
      <p className="git-review-bar" role="status" data-testid="git-review-running">
        <SpinnerGlyph size={12} /> {t('git.review.running')}
      </p>
    ) : record === undefined ? null : (
      <ReviewBar
        sessionId={sessionId}
        scopeKey={key}
        review={record.review}
        findings={findings}
        stale={record.changesKey !== changesKeyOf(files)}
        inline={inline}
        onReveal={onReveal}
      />
    );
  return (
    <InlineContext.Provider value={value}>
      {bar}
      {children}
    </InlineContext.Provider>
  );
}

function ReviewBar({
  sessionId,
  scopeKey: key,
  review,
  findings,
  stale,
  inline,
  onReveal,
}: {
  readonly sessionId: string;
  readonly scopeKey: string;
  readonly review: Review;
  readonly findings: readonly Finding[];
  readonly stale: boolean;
  readonly inline: boolean;
  readonly onReveal: (path: string, line: number, findingId?: string) => void;
}) {
  const t = useT();
  const turn = useTurnInfo(sessionId);
  const [at, setAt] = useState(-1);
  const [sending, setSending] = useState(false);
  const step = (direction: 1 | -1) => {
    if (findings.length === 0) return;
    const next = (at + direction + findings.length) % findings.length;
    setAt(next);
    const f = findings[next];
    if (f !== undefined) onReveal(f.path, f.line, findingId(f));
  };
  const fix = async () => {
    setSending(true);
    try {
      const text = formatFindings(findings, reviewHeading(review));
      // While the agent works, the message waits in the queue (like the comments' send).
      await (turn.running
        ? window.piarc.followUp(sessionId, text)
        : window.piarc.prompt(sessionId, text));
      pushNotice(sessionId, {
        tone: 'info',
        text: t('git.review.sent', { count: findings.length }),
        actions: [],
      });
    } catch (error) {
      pushNotice(sessionId, { tone: 'error', text: reason(error), actions: [] });
    } finally {
      setSending(false);
    }
  };
  return (
    <section
      className="git-review"
      aria-label={t('git.review.title')}
      data-testid="git-review-bar"
      data-presentation={inline ? 'inline' : 'separate'}
    >
      <div className="git-review-bar">
        <ReviewIcon size={12} />
        <span className="git-review-count" data-testid="git-review-count">
          {t('git.review.count', { count: findings.length })}
        </span>
        {inline && findings.length > 1 ? (
          <>
            <IconButton
              label={t('git.review.previous')}
              size="xs"
              data-testid="git-review-previous"
              onClick={() => {
                step(-1);
              }}
            >
              <CaretUpGlyph size={12} />
            </IconButton>
            <IconButton
              label={t('git.review.next')}
              size="xs"
              data-testid="git-review-next"
              onClick={() => {
                step(1);
              }}
            >
              <CaretDownGlyph size={12} />
            </IconButton>
          </>
        ) : null}
        <span className="git-sync-spacer" />
        <Button
          size="small"
          variant="primary"
          loading={sending}
          disabled={findings.length === 0}
          data-testid="git-review-fix"
          onClick={() => void fix()}
        >
          {t('git.review.fix')}
        </Button>
        <Button
          size="small"
          variant="ghost"
          data-testid="git-review-clear"
          onClick={() => {
            clearReview(sessionId, key);
          }}
        >
          {t('git.review.clear')}
        </Button>
      </div>
      {review.summary === '' ? null : (
        <p className="git-review-summary" data-testid="git-review-summary">
          {revealBidi(review.summary)}
        </p>
      )}
      <ReviewNotes review={review} stale={stale} />
      {inline ? null : (
        <ReviewList
          findings={findings}
          onDismiss={(id) => {
            dismissFinding(sessionId, key, id);
          }}
          onReveal={onReveal}
        />
      )}
    </section>
  );
}

function ReviewNotes({ review, stale }: { readonly review: Review; readonly stale: boolean }) {
  const t = useT();
  return (
    <>
      {stale ? (
        <p className="git-review-note" data-testid="git-review-stale">
          {t('git.review.stale')}
        </p>
      ) : null}
      {review.dropped === 0 ? null : (
        <p className="git-review-note" data-testid="git-review-dropped">
          {t('git.review.dropped', { count: review.dropped })}
        </p>
      )}
      {review.fallback ? (
        <p className="git-review-note">{t('git.commit.fallbackModel', { model: review.model })}</p>
      ) : null}
      {review.withheld.length === 0 ? null : (
        <p
          className="git-review-note"
          data-testid="git-review-withheld"
          data-tooltip={review.withheld.map((w) => revealBidi(w)).join('\n')}
        >
          {t('git.review.withheld', { count: review.withheld.length })}
        </p>
      )}
    </>
  );
}

/** The separate presentation: the findings grouped by file. */
function ReviewList({
  findings,
  onDismiss,
  onReveal,
}: {
  readonly findings: readonly Finding[];
  readonly onDismiss: (id: string) => void;
  readonly onReveal: (path: string, line: number) => void;
}) {
  const t = useT();
  const groups = new Map<string, Finding[]>();
  for (const f of findings) groups.set(f.path, [...(groups.get(f.path) ?? []), f]);
  if (findings.length === 0) {
    return <p className="git-review-note">{t('git.review.none')}</p>;
  }
  return (
    <div className="git-review-list" data-testid="git-review-list">
      {[...groups].map(([path, list]) => (
        // A group under its heading, not a landmark: the diff's file section has the same name.
        <div key={path} className="git-review-file">
          <h2 className="git-review-path">{revealBidi(path)}</h2>
          <ul>
            {list.map((f) => {
              const id = findingId(f);
              return (
                <li key={id} className="git-finding" data-testid="git-finding" data-finding={id}>
                  <FindingCard
                    finding={f}
                    onDismiss={() => {
                      onDismiss(id);
                    }}
                    onPick={() => {
                      onReveal(f.path, f.line);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
