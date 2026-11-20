// The question form (T26): AskUserQuestion's questions as a card of the approval ledger, shown
// in every permission mode. Each question takes one option (radio buttons), several
// (checkboxes) or an answer of the user's own ("Other"). Mod+Enter submits, Esc skips the
// questions (with the feedback, if any). Core answers the model; a configured timeout may answer
// first, and the card then goes away.
import type { ApprovalRequest, Question } from '@piarc/protocol';
import { useRef, useState } from 'react';

import { useT } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { answerRequest } from './answer.js';
import { useApprovalKeys } from './use-approval-keys.js';
import { ApprovalOrigin } from './ApprovalOrigin.js';

interface Draft {
  readonly selected: readonly string[];
  readonly other: string;
  readonly otherChosen: boolean;
}

const EMPTY: Draft = { selected: [], other: '', otherChosen: false };

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

function QuestionFields({
  name,
  question,
  draft,
  onChange,
}: {
  readonly name: string;
  readonly question: Question;
  readonly draft: Draft;
  readonly onChange: (draft: Draft) => void;
}) {
  const t = useT();
  const many = question.multiSelect === true;
  const pick = (label: string, on: boolean) => {
    if (many) {
      const selected = on ? [...draft.selected, label] : draft.selected.filter((s) => s !== label);
      onChange({ ...draft, selected });
    } else if (on) {
      onChange({ ...draft, selected: [label], otherChosen: false });
    }
  };
  return (
    <fieldset className="question" data-testid="question">
      <legend>
        {question.header && <span className="question-header">{question.header}</span>}
        <span className="question-text">{question.question}</span>
        {many && <span className="muted"> · {t('question.multiple')}</span>}
      </legend>
      {question.options.map((option) => (
        <label key={option.label} className="question-option">
          <input
            type={many ? 'checkbox' : 'radio'}
            name={name}
            checked={draft.selected.includes(option.label)}
            onChange={(e) => {
              pick(option.label, e.target.checked);
            }}
          />
          <span>
            {option.label}
            {option.description && <span className="muted"> — {option.description}</span>}
          </span>
        </label>
      ))}
      <label className="question-option">
        <input
          type={many ? 'checkbox' : 'radio'}
          name={name}
          checked={draft.otherChosen}
          data-testid="question-other-choice"
          onChange={(e) => {
            onChange(
              many
                ? { ...draft, otherChosen: e.target.checked }
                : { ...draft, selected: [], otherChosen: true },
            );
          }}
        />
        <span>{t('question.other')}</span>
      </label>
      <input
        className="question-other"
        value={draft.other}
        placeholder={t('question.otherPlaceholder')}
        aria-label={t('question.other')}
        data-testid="question-other"
        onChange={(e) => {
          const other = e.target.value;
          onChange(
            many
              ? { ...draft, other, otherChosen: other.trim() !== '' || draft.otherChosen }
              : { selected: other.trim() ? [] : draft.selected, other, otherChosen: true },
          );
        }}
      />
    </fieldset>
  );
}

export function QuestionForm({ request }: { readonly request: ApprovalRequest }) {
  const t = useT();
  const card = useRef<HTMLElement>(null);
  const questions = request.questions ?? [];
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => questions.map(() => EMPTY));
  const [feedback, setFeedback] = useState('');
  const busy = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const answers = formAnswers(questions, drafts);

  function send(decline: boolean) {
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
  useApprovalKeys(
    card,
    (key) => {
      send(key === 'deny');
    },
    (key) => key === 'allowSession',
  );

  return (
    <section
      ref={card}
      className="row approval-card question-card"
      tabIndex={-1}
      data-testid="approval-card"
      data-approval-card="question"
      data-request-id={request.requestId}
    >
      <header>
        <strong>{t('approval.kind.question')}</strong>
      </header>
      <ApprovalOrigin request={request} />
      {questions.map((question, i) => (
        <QuestionFields
          key={String(i)}
          name={`${request.requestId}-${String(i)}`}
          question={question}
          draft={drafts[i] ?? EMPTY}
          onChange={(draft) => {
            setDrafts((current) => current.map((d, j) => (j === i ? draft : d)));
          }}
        />
      ))}
      <label>
        {t('approval.feedback')}
        <input
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
          disabled={waiting || answers === undefined}
          data-testid="question-submit"
          onClick={() => {
            send(false);
          }}
        >
          {t('question.submit')}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
