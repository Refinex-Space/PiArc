// The question form (T26): AskUserQuestion's questions as a card of the approval ledger, shown
// in every permission mode. The card shows one question at a time with a pager ("‹ 1 / 3 ›").
// Each question takes one option (radio buttons), several (checkboxes) or an answer of the
// user's own ("Other", whose field shows once chosen). A pointer pick on a single-select
// question moves on to the next one by itself; keyboard choices stay, and Enter or Mod+Enter
// moves on. The last page submits every answer (a question left unanswered is shown first);
// Esc skips the questions (with the feedback, if any). Core answers the model; a configured
// timeout may answer first, and the card then goes away.
import { approvalLabel } from './approval-label.js';
import type { ApprovalRequest, Question } from '@piarc/protocol';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { useApp } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { Keycaps } from '../app/Keycaps.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { reason } from '../shell/errors.js';
import { ChevronLeftIcon, ChevronRightIcon } from '../shell/icons.js';
import { answerRequest } from './answer.js';
import { useApprovalKeys } from './use-approval-keys.js';
import { ApprovalOrigin } from './ApprovalOrigin.js';

interface Draft {
  readonly selected: readonly string[];
  readonly other: string;
  readonly otherChosen: boolean;
}

const EMPTY: Draft = { selected: [], other: '', otherChosen: false };

/** How long a picked option stays in view before the next question replaces it. */
export const AUTO_ADVANCE_MS = 180;

/** Whether a question's draft is an answer: an option, or an own answer that is not blank. */
export function isAnswered(draft: Draft | undefined): boolean {
  if (draft === undefined) return false;
  return draft.selected.length > 0 || (draft.otherChosen && draft.other.trim() !== '');
}

/** The answers to send, or undefined while a question has none. */
export function formAnswers(
  questions: readonly Question[],
  drafts: readonly Draft[],
): { selected?: string[]; other?: string }[] | undefined {
  const answers = questions.map((_, i) => {
    const draft = drafts[i] ?? EMPTY;
    const other = draft.otherChosen ? draft.other.trim() : '';
    return {
      ...(draft.selected.length === 0 ? {} : { selected: [...draft.selected] }),
      ...(other ? { other } : {}),
    };
  });
  return answers.every((a) => a.selected !== undefined || a.other !== undefined)
    ? answers
    : undefined;
}

/** Whether a key event is a plain Enter outside an input method composition. */
function plainEnter(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    !isImeComposing(event.nativeEvent) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey
  );
}

function QuestionFields({
  name,
  question,
  draft,
  pager,
  onChange,
  onPicked,
  onEnter,
}: {
  readonly name: string;
  readonly question: Question;
  readonly draft: Draft;
  readonly pager: ReactNode;
  readonly onChange: (draft: Draft) => void;
  /** A single-select option was picked with the pointer. */
  readonly onPicked: () => void;
  readonly onEnter: () => void;
}) {
  const { t } = useApp();
  const many = question.multiSelect === true;
  const free = question.options.length === 0;
  const pointer = useRef(false);
  const otherField = useRef<HTMLInputElement>(null);
  const [focusOther, setFocusOther] = useState(false);
  useEffect(() => {
    if (!focusOther) return;
    setFocusOther(false);
    otherField.current?.focus();
  }, [focusOther]);
  const pick = (label: string, on: boolean) => {
    const byPointer = pointer.current;
    pointer.current = false;
    if (many) {
      const selected = on ? [...draft.selected, label] : draft.selected.filter((s) => s !== label);
      onChange({ ...draft, selected });
    } else if (on) {
      onChange({ ...draft, selected: [label], otherChosen: false });
      if (byPointer) onPicked();
    }
  };
  const pressed = () => {
    pointer.current = true;
  };
  const showField = free || draft.otherChosen;
  const headingId = `${name}-heading`;
  return (
    <div
      className="question"
      role="group"
      aria-labelledby={headingId}
      data-testid="question"
      onKeyDown={(event) => {
        pointer.current = false;
        if (
          plainEnter(event) &&
          event.target instanceof HTMLInputElement &&
          (event.target.type === 'radio' || event.target.type === 'checkbox')
        ) {
          event.preventDefault();
          onEnter();
        }
      }}
    >
      <div className="question-head">
        <p className="question-title" id={headingId}>
          {question.header && <span className="question-header">{question.header}</span>}
          <span className="question-text">{question.question}</span>
          {many && <span className="question-hint"> · {t('question.multiple')}</span>}
        </p>
        {pager}
      </div>
      <div className="question-options">
        {question.options.map((option) => {
          const checked = draft.selected.includes(option.label);
          return (
            <label
              key={option.label}
              className="question-option"
              data-selected={checked || undefined}
              onPointerDown={pressed}
            >
              <input
                type={many ? 'checkbox' : 'radio'}
                name={name}
                checked={checked}
                onChange={(e) => {
                  pick(option.label, e.target.checked);
                }}
              />
              <span className="question-option-text">
                <span className="question-option-label">{option.label}</span>
                {option.description && (
                  <span className="question-option-description">{option.description}</span>
                )}
              </span>
            </label>
          );
        })}
        {!free && (
          <label className="question-option" data-selected={draft.otherChosen || undefined}>
            <input
              type={many ? 'checkbox' : 'radio'}
              name={name}
              checked={draft.otherChosen}
              data-testid="question-other-choice"
              onChange={(e) => {
                const on = e.target.checked;
                onChange(
                  many
                    ? { ...draft, otherChosen: on }
                    : { ...draft, selected: [], otherChosen: true },
                );
                if (on) setFocusOther(true);
              }}
            />
            <span className="question-option-label">{t('question.other')}</span>
          </label>
        )}
        {showField && (
          <div className="question-other-row">
            <input
              ref={otherField}
              className="question-other"
              value={draft.other}
              placeholder={t('question.otherPlaceholder')}
              aria-label={free ? question.question : t('question.other')}
              data-testid="question-other"
              onChange={(e) => {
                const other = e.target.value;
                onChange(
                  many
                    ? { ...draft, other, otherChosen: other.trim() !== '' || draft.otherChosen }
                    : { selected: other.trim() ? [] : draft.selected, other, otherChosen: true },
                );
              }}
              onKeyDown={(e) => {
                if (!plainEnter(e)) return;
                e.preventDefault();
                e.stopPropagation();
                onEnter();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function QuestionForm({ request }: { readonly request: ApprovalRequest }) {
  const { t, keyPlatform } = useApp();
  const card = useRef<HTMLElement>(null);
  const questions = request.questions ?? [];
  const count = questions.length;
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => questions.map(() => EMPTY));
  const [page, setPage] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [feedback, setFeedback] = useState('');
  const busy = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refocus = useRef(false);
  const answers = formAnswers(questions, drafts);
  const current = Math.min(page, Math.max(count - 1, 0));
  const last = current >= count - 1;
  const question = questions[current];
  const answeredHere = isAnswered(drafts[current]);

  const cancelAutoAdvance = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => cancelAutoAdvance, []);
  // A page change that started inside the card keeps focus there: on the new page's choice.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    const root = card.current;
    const target =
      root?.querySelector<HTMLInputElement>('.question input:checked') ??
      root?.querySelector<HTMLInputElement>('.question input');
    (target ?? root)?.focus({ preventScroll: true });
  }, [current]);

  function goTo(next: number) {
    cancelAutoAdvance();
    if (next < 0 || next >= count || next === current) return;
    const active = document.activeElement;
    refocus.current = active !== null && card.current?.contains(active) === true;
    setDirection(next > current ? 'forward' : 'back');
    setPage(next);
    setError('');
  }

  function send(decline: boolean) {
    cancelAutoAdvance();
    if (busy.current) return;
    if (!decline && answers === undefined) {
      setError(t('question.incomplete'));
      return;
    }
    busy.current = true;
    setWaiting(true);
    setError('');
    answerRequest(
      request,
      decline
        ? { decision: 'deny', ...(feedback.trim() ? { feedback: feedback.trim() } : {}) }
        : { decision: 'allowOnce', answers: answers ?? [] },
    )
      .then((outcome) => {
        if (outcome === 'handled') setError(t('approval.handled'));
        if (outcome === 'cancelled') {
          busy.current = false;
          setWaiting(false);
        }
      })
      .catch((e: unknown) => {
        setError(reason(e));
        busy.current = false;
        setWaiting(false);
      });
  }

  /** The primary action: the next question, or on the last page every answer. */
  function advance() {
    cancelAutoAdvance();
    if (busy.current || !answeredHere) return;
    if (!last) {
      goTo(current + 1);
      return;
    }
    const open = drafts.findIndex((draft, i) => i < count && !isAnswered(draft));
    if (open !== -1) {
      goTo(open);
      setError(t('question.unansweredAt', { n: open + 1 }));
      return;
    }
    send(false);
  }

  useApprovalKeys(
    card,
    (key) => {
      if (key === 'deny') send(true);
      else advance();
    },
    (key) => key === 'allowSession',
  );

  const pager =
    count > 1 ? (
      <span className="question-pager">
        <IconButton
          size="xs"
          label={t('question.showPrevious')}
          disabled={waiting || current === 0}
          data-testid="question-prev"
          onClick={() => {
            goTo(current - 1);
          }}
        >
          <ChevronLeftIcon />
        </IconButton>
        <span className="question-position" data-testid="question-position">
          {t('question.position', { position: current + 1, count })}
        </span>
        <IconButton
          size="xs"
          label={t('question.showNext')}
          disabled={waiting || last}
          data-testid="question-next-page"
          onClick={() => {
            goTo(current + 1);
          }}
        >
          <ChevronRightIcon />
        </IconButton>
      </span>
    ) : null;

  return (
    <section
      ref={card}
      className="row approval-card question-card"
      tabIndex={-1}
      aria-label={approvalLabel(request, t)}
      data-testid="approval-card"
      data-approval-card="question"
      data-request-id={request.requestId}
    >
      <div className="approval-box is-question">
        <header className="approval-title approval-strip">
          <strong>{t('approval.kind.question')}</strong>
        </header>
        <ApprovalOrigin request={request} />
        {question && (
          <div
            key={current}
            className="question-page"
            data-direction={direction}
            data-question-page={current}
          >
            <QuestionFields
              name={`${request.requestId}-${String(current)}`}
              question={question}
              draft={drafts[current] ?? EMPTY}
              pager={pager}
              onChange={(draft) => {
                cancelAutoAdvance();
                setError('');
                setDrafts((all) => all.map((d, j) => (j === current ? draft : d)));
              }}
              onPicked={() => {
                if (last) return;
                cancelAutoAdvance();
                timer.current = setTimeout(() => {
                  timer.current = undefined;
                  goTo(current + 1);
                }, AUTO_ADVANCE_MS);
              }}
              onEnter={advance}
            />
          </div>
        )}
        <label className="approval-field question-feedback">
          <span className="visually-hidden">{t('approval.feedback')}</span>
          <input
            placeholder={t('approval.feedback')}
            value={feedback}
            onChange={(e) => {
              setFeedback(e.target.value);
            }}
          />
        </label>
        <div className="approval-actions">
          <button
            type="button"
            className="button"
            disabled={waiting}
            data-testid="question-decline"
            onClick={() => {
              send(true);
            }}
          >
            {t('question.decline')}
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={waiting || !answeredHere}
            data-testid="question-submit"
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onClick={advance}
          >
            {last ? t('question.submit') : t('question.next')}
            <span className="approval-keys" aria-hidden="true">
              <Keycaps binding="Mod+Enter" platform={keyPlatform} />
            </span>
          </button>
        </div>
        {error && (
          <p className="approval-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
