// Provider sign-in in the settings window (T29, architecture section 5.4). Core runs the sign-in
// on a settings Agent Host and reports each step on `core/login`: the authorization page (opened
// in the system browser after the main process's confirmation; never in a PiArc window), a device
// code, a question, progress, and how it ended. The token never reaches this window.
//
// A page or code to act on and a question can be on screen together: some flows show the
// authorization page and at the same time ask for the redirect URL in case the loopback callback
// does not arrive (Core replaces a question with the next one, never a link).
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { LoginInteraction } from '@piarc/protocol';

import { useT } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { Dialog } from '../shell/Dialog.js';
import { CheckGlyph, CopyGlyph, ExternalGlyph } from '../shell/icons.js';
import type { LoginProvider } from './provider-form.js';
import { Button } from '../app/Button.js';

type Link = Extract<LoginInteraction, { type: 'authUrl' } | { type: 'deviceCode' }>;
type Question = Extract<LoginInteraction, { type: 'prompt' }>;
interface InfoLink {
  readonly url: string;
  readonly label?: string;
}

interface LoginView {
  readonly provider: LoginProvider;
  readonly loginId?: string;
  /** The page to open or the code to enter. */
  readonly link?: Link;
  /** The question waiting for an answer (gone once answered). */
  readonly question?: Question | undefined;
  /** The latest status line (progress or information) and the links it came with. */
  readonly note?: string;
  readonly links?: readonly InfoLink[];
  readonly outcome?: {
    readonly state: 'succeeded' | 'failed' | 'cancelled';
    readonly message?: string;
    /** The provider could not be reached: the proxy settings may help (ADR-0082). */
    readonly network?: boolean;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `core/login` events of one batch. */
function eventsOf(payload: Uint8Array): Record<string, unknown>[] {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function linksOf(value: unknown): InfoLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .flatMap((link) =>
      typeof link.url === 'string'
        ? [{ url: link.url, ...(typeof link.label === 'string' ? { label: link.label } : {}) }]
        : [],
    );
}

export function next(view: LoginView, event: Record<string, unknown>): LoginView {
  if (event.provider !== view.provider.id) return view;
  if (view.loginId !== undefined && event.loginId !== view.loginId) return view;
  const loginId = typeof event.loginId === 'string' ? event.loginId : view.loginId;
  const base = { ...view, ...(loginId === undefined ? {} : { loginId }) };
  const state = event.state;
  if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
    return {
      ...base,
      outcome: {
        state,
        ...(typeof event.message === 'string' ? { message: event.message } : {}),
        ...(event.network === true ? { network: true } : {}),
      },
    };
  }
  const interaction = event.interaction;
  if (state !== 'interaction' || !isRecord(interaction)) return base;
  // Shapes are Core's (validated against the protocol schema); unknown kinds are ignored.
  switch (interaction.type) {
    case 'authUrl':
    case 'deviceCode':
      return { ...base, link: interaction as unknown as Link };
    case 'prompt':
      return { ...base, question: interaction as unknown as Question };
    case 'progress':
      return typeof interaction.message === 'string'
        ? { ...base, note: interaction.message, links: [] }
        : base;
    case 'info':
      return typeof interaction.message === 'string'
        ? { ...base, note: interaction.message, links: linksOf(interaction.links) }
        : base;
    default:
      return base;
  }
}

/** Copies text and says so for a moment. */
function useCopy(): readonly [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setCopied(false);
        }, 1500);
      },
      () => undefined,
    );
  }, []);
  return [copied, copy];
}

function CopyButton({
  text,
  label,
  testId,
}: {
  readonly text: string;
  readonly label: string;
  readonly testId: string;
}) {
  const t = useT();
  const [copied, copy] = useCopy();
  return (
    <Button
      size="small"
      variant="ghost"
      className="login-copy"
      data-testid={testId}
      data-copied={copied || undefined}
      onClick={() => {
        copy(text);
      }}
    >
      {copied ? <CheckGlyph size={12} /> : <CopyGlyph size={12} />}
      <span aria-live="polite">{copied ? t('login.copied') : label}</span>
    </Button>
  );
}

function LinkView({ link, primary }: { readonly link: Link; readonly primary: boolean }) {
  const t = useT();
  const [copied, copy] = useCopy();
  if (link.type === 'authUrl') {
    return (
      <div className="login-step" data-testid="login-auth-url">
        <p>{t('login.authUrl')}</p>
        <div className="login-actions">
          <Button
            variant={primary ? 'primary' : 'secondary'}
            data-autofocus={primary || undefined}
            data-testid="login-open-browser"
            onClick={() => {
              void window.piarc.openExternal(link.url);
            }}
          >
            {t('login.openBrowser')}
          </Button>
          <CopyButton text={link.url} label={t('login.copyLink')} testId="login-copy-link" />
        </div>
      </div>
    );
  }
  return (
    <div className="login-step" data-testid="login-device-code">
      <p>{t('login.deviceCode')}</p>
      <button
        type="button"
        className="login-code"
        data-testid="login-user-code"
        data-copied={copied || undefined}
        onClick={() => {
          copy(link.userCode);
        }}
      >
        <span>{link.userCode}</span>
        <span className="login-code-hint" aria-live="polite">
          {copied ? <CheckGlyph size={12} /> : <CopyGlyph size={12} />}
          {copied ? t('login.copied') : t('login.copyCode')}
        </span>
      </button>
      {link.expiresInSeconds == null ? null : (
        <p className="muted small">
          {t('login.expires', { minutes: Math.max(1, Math.round(link.expiresInSeconds / 60)) })}
        </p>
      )}
      <div className="login-actions">
        <Button
          variant={primary ? 'primary' : 'secondary'}
          data-autofocus={primary || undefined}
          data-testid="login-open-verification"
          onClick={() => {
            void window.piarc.openExternal(link.verificationUri);
          }}
        >
          {t('login.openVerification')}
        </Button>
      </div>
    </div>
  );
}

function QuestionView({
  question,
  autofocus,
  onAnswer,
}: {
  readonly question: Question;
  readonly autofocus: boolean;
  readonly onAnswer: (value: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [answer, setAnswer] = useState('');
  if (question.kind === 'select') {
    return (
      <fieldset className="login-step login-options" data-testid="login-prompt">
        <legend className="setting-label">{question.message}</legend>
        {(question.options ?? []).map((option, index) => (
          <button
            key={option.id}
            type="button"
            className="login-option"
            data-testid={`login-option-${option.id}`}
            data-autofocus={(autofocus && index === 0) || undefined}
            onClick={() => {
              onAnswer(option.id);
            }}
          >
            <span>{option.label}</span>
            {option.description == null ? null : (
              <span className="muted small">{option.description}</span>
            )}
          </button>
        ))}
      </fieldset>
    );
  }
  // A plain question may be answered with nothing (for example "blank for the default").
  const required = question.kind !== 'text';
  return (
    <form
      className="login-step"
      data-testid="login-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        if (!required || answer !== '') onAnswer(answer);
      }}
    >
      <label className="setting-label" htmlFor={id}>
        {question.message}
      </label>
      <div className="login-answer">
        <input
          id={id}
          className="input"
          data-autofocus={autofocus || undefined}
          data-testid="login-answer"
          type={question.kind === 'secret' ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          placeholder={question.placeholder ?? ''}
          value={answer}
          onChange={(e) => {
            setAnswer(e.currentTarget.value);
          }}
        />
        <Button type="submit" disabled={required && answer === ''}>
          {t('login.submit')}
        </Button>
      </div>
    </form>
  );
}

function StepsView({
  view,
  onAnswer,
}: {
  readonly view: LoginView;
  readonly onAnswer: (value: string) => void;
}) {
  const t = useT();
  const { link, question } = view;
  if (link === undefined && question === undefined) {
    return (
      <p className="muted" role="status">
        {t('login.starting')}
      </p>
    );
  }
  // A pasted redirect URL is the fallback of a page already open: the page stays the main action.
  const linkFirst = link !== undefined && question?.kind !== 'select';
  return (
    <>
      {link === undefined ? null : <LinkView link={link} primary={linkFirst} />}
      {question === undefined ? null : (
        <QuestionView
          key={JSON.stringify(question)}
          question={question}
          autofocus={!linkFirst}
          onAnswer={onAnswer}
        />
      )}
    </>
  );
}

/** A sign-in in progress and its dialog: the steps Core reports on `core/login` for `provider`
 * (a model provider, T29, or an MCP server `mcp:<name>`, T36). `start` runs the sign-in.
 * `accountOf` names the account in use of a provider (ADR-0083), for the success line. */
export function useSignInDialog(
  onChanged: () => void,
  accountOf?: (provider: string) => string | undefined,
): {
  readonly open: boolean;
  readonly failure: string;
  readonly start: (provider: LoginProvider, run: () => Promise<unknown>) => void;
  readonly dialog: ReactNode;
} {
  const t = useT();
  const titleId = useId();
  const [view, setView] = useState<LoginView>();
  const [failure, setFailure] = useState('');
  const viewRef = useRef(view);
  viewRef.current = view;
  const runRef = useRef<() => Promise<unknown>>(undefined);
  // The account in use before the sign-in: a new name after it is the account just signed in.
  const beforeRef = useRef<string | undefined>(undefined);
  const open = view !== undefined;
  useEffect(() => {
    if (!open) return;
    const route = 'core/login';
    window.piarc
      .subscribeEvents(route, (batch) => {
        setView((current) => {
          if (current === undefined) return current;
          return eventsOf(batch.payload).reduce(next, current);
        });
      })
      .catch((e: unknown) => {
        setFailure(reason(e));
      });
    return () => {
      void window.piarc.unsubscribeEvents(route);
    };
  }, [open]);
  const start = useCallback(
    (provider: LoginProvider, run: () => Promise<unknown>) => {
      setFailure('');
      runRef.current = run;
      beforeRef.current = accountOf?.(provider.id);
      setView({ provider });
      run().then(
        () => {
          onChanged();
        },
        (e: unknown) => {
          // The end state (failed, cancelled) also arrives on `core/login`; keep its message.
          setView((current) =>
            current === undefined || current.outcome !== undefined
              ? current
              : { ...current, outcome: { state: 'failed', message: reason(e) } },
          );
        },
      );
    },
    [onChanged, accountOf],
  );
  const cancel = useCallback(() => {
    const current = viewRef.current;
    if (current === undefined) return;
    if (current.outcome !== undefined || current.loginId === undefined) {
      if (current.outcome !== undefined) setView(undefined);
      return;
    }
    void window.piarc.answerLogin(current.loginId, null);
  }, []);
  const answer = useCallback((value: string) => {
    const current = viewRef.current;
    if (current?.loginId === undefined) return;
    // The answered question leaves the screen; the next step replaces it.
    setView({ ...current, question: undefined });
    void window.piarc.answerLogin(current.loginId, value);
  }, []);
  const outcome = view?.outcome;
  const account = view === undefined ? undefined : accountOf?.(view.provider.id);
  const signedInAs = account !== undefined && account !== beforeRef.current ? account : undefined;
  // Steps arrive after the dialog opened: each one takes the focus (its main action, or the
  // title while there is none), so the keyboard and Escape keep working inside the dialog.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stepKey =
    view === undefined
      ? ''
      : JSON.stringify([view.link ?? null, view.question ?? null, outcome?.state ?? null]);
  useEffect(() => {
    const dialog = titleRef.current?.closest('[role="dialog"]');
    if (dialog === null || dialog === undefined) return;
    const target = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? titleRef.current;
    target?.focus();
  }, [stepKey]);
  const dialog =
    view === undefined ? null : (
      <Dialog labelledBy={titleId} onCancel={cancel} testId="login-dialog" className="login-dialog">
        <h2 id={titleId} className="dialog-title" ref={titleRef} tabIndex={-1}>
          {t('login.title', { name: view.provider.name })}
        </h2>
        {outcome === undefined ? (
          <>
            <StepsView view={view} onAnswer={answer} />
            {view.note === undefined ? null : (
              <p className="muted small login-note" role="status" data-testid="login-note">
                {view.note}
              </p>
            )}
            {view.links === undefined || view.links.length === 0 ? null : (
              <div className="login-actions">
                {view.links.map((link) => (
                  <Button
                    key={link.url}
                    size="small"
                    variant="ghost"
                    onClick={() => {
                      void window.piarc.openExternal(link.url);
                    }}
                  >
                    <ExternalGlyph size={12} />
                    {link.label ?? link.url}
                  </Button>
                ))}
              </div>
            )}
            <div className="dialog-actions">
              <Button
                variant="ghost"
                data-testid="login-cancel"
                disabled={view.loginId === undefined}
                onClick={cancel}
              >
                {t('login.cancel')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p
              role={outcome.state === 'succeeded' ? 'status' : 'alert'}
              className={`login-outcome${outcome.state === 'failed' ? ' error-text' : ''}`}
              data-testid="login-outcome"
              data-state={outcome.state}
            >
              {outcome.state === 'succeeded'
                ? signedInAs === undefined
                  ? t('login.succeeded', { name: view.provider.name })
                  : t('login.succeededAs', { name: view.provider.name, account: signedInAs })
                : outcome.state === 'cancelled'
                  ? t('login.cancelled')
                  : t('login.failed', { message: outcome.message ?? '' })}
            </p>
            <div className="dialog-actions">
              {outcome.network === true ? (
                <Button
                  variant="ghost"
                  className="login-proxy"
                  data-testid="login-proxy"
                  onClick={() => {
                    setView(undefined);
                    window.location.hash = '#/settings/proxy';
                  }}
                >
                  {t('login.proxy')}
                </Button>
              ) : null}
              {outcome.state === 'succeeded' || runRef.current === undefined ? null : (
                <Button
                  data-testid="login-retry"
                  onClick={() => {
                    const run = runRef.current;
                    if (run !== undefined) start(view.provider, run);
                  }}
                >
                  {t('login.retry')}
                </Button>
              )}
              <Button
                variant="primary"
                data-autofocus
                data-testid="login-close"
                onClick={() => {
                  setView(undefined);
                }}
              >
                {t('login.close')}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    );
  return { open, failure, start, dialog };
}
