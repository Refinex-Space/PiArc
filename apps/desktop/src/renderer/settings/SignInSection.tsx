// Provider sign-in in the settings window (T29, architecture section 5.4). Core runs the sign-in
// on a settings Agent Host and reports each step on `core/login`: the authorization page (opened
// in the system browser after the main process's confirmation; never in a PiArc window), a device
// code, a question, progress, and how it ended. The token never reaches this window.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { LoginInteraction } from '@piarc/protocol';

import { useT } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { Dialog } from '../shell/Dialog.js';
import type { LoginProvider } from './provider-form.js';
import { Button } from '../app/Button.js';

type Step = Exclude<LoginInteraction, { type: 'progress' } | { type: 'info' }>;

interface LoginView {
  readonly provider: LoginProvider;
  readonly loginId?: string;
  /** What the user acts on now: the page to open, a code to enter, a question. */
  readonly step?: Step;
  /** The latest status line (progress or information). */
  readonly note?: string;
  readonly outcome?: {
    readonly state: 'succeeded' | 'failed' | 'cancelled';
    readonly message?: string;
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

function next(view: LoginView, event: Record<string, unknown>): LoginView {
  if (event.provider !== view.provider.id) return view;
  if (view.loginId !== undefined && event.loginId !== view.loginId) return view;
  const loginId = typeof event.loginId === 'string' ? event.loginId : view.loginId;
  const state = event.state;
  if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
    return {
      ...view,
      ...(loginId === undefined ? {} : { loginId }),
      outcome: {
        state,
        ...(typeof event.message === 'string' ? { message: event.message } : {}),
      },
    };
  }
  const interaction = event.interaction;
  if (state !== 'interaction' || !isRecord(interaction)) {
    return { ...view, ...(loginId === undefined ? {} : { loginId }) };
  }
  const base = { ...view, ...(loginId === undefined ? {} : { loginId }) };
  // Shapes are Core's (validated against the protocol schema); unknown kinds are ignored.
  switch (interaction.type) {
    case 'authUrl':
    case 'deviceCode':
    case 'prompt':
      return { ...base, step: interaction as unknown as Step };
    case 'progress':
    case 'info':
      return typeof interaction.message === 'string'
        ? { ...base, note: interaction.message }
        : base;
    default:
      return base;
  }
}

function StepView({
  view,
  onAnswer,
}: {
  readonly view: LoginView;
  readonly onAnswer: (value: string) => void;
}) {
  const t = useT();
  const [answer, setAnswer] = useState('');
  const step = view.step;
  if (step === undefined) {
    return <p className="muted">{t('login.starting')}</p>;
  }
  switch (step.type) {
    case 'authUrl':
      return (
        <div className="login-step" data-testid="login-auth-url">
          <p>{t('login.authUrl')}</p>
          {step.instructions == null ? null : <p className="muted small">{step.instructions}</p>}
          <Button
            variant="primary"
            data-autofocus
            data-testid="login-open-browser"
            onClick={() => {
              void window.piarc.openExternal(step.url);
            }}
          >
            {t('login.openBrowser')}
          </Button>
        </div>
      );
    case 'deviceCode':
      return (
        <div className="login-step" data-testid="login-device-code">
          <p>{t('login.deviceCode')}</p>
          <p className="login-code" data-testid="login-user-code">
            {step.userCode}
          </p>
          {step.expiresInSeconds == null ? null : (
            <p className="muted small">
              {t('login.expires', { minutes: Math.max(1, Math.round(step.expiresInSeconds / 60)) })}
            </p>
          )}
          <div className="dialog-actions">
            <Button
              size="small"
              onClick={() => {
                void navigator.clipboard.writeText(step.userCode);
              }}
            >
              {t('login.copyCode')}
            </Button>
            <Button
              variant="primary"
              data-autofocus
              data-testid="login-open-verification"
              onClick={() => {
                void window.piarc.openExternal(step.verificationUri);
              }}
            >
              {t('login.openVerification')}
            </Button>
          </div>
        </div>
      );
    case 'prompt':
      return (
        <form
          className="login-step"
          data-testid="login-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            if (answer !== '') onAnswer(answer);
          }}
        >
          <label className="setting-label" htmlFor="login-answer">
            {step.message}
          </label>
          {step.kind === 'select' ? (
            <select
              id="login-answer"
              className="input"
              data-autofocus
              value={answer}
              onChange={(e) => {
                setAnswer(e.currentTarget.value);
              }}
            >
              <option value="" disabled>
                {step.placeholder ?? ''}
              </option>
              {(step.options ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="login-answer"
              className="input"
              data-autofocus
              data-testid="login-answer"
              type={step.kind === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              placeholder={step.placeholder ?? ''}
              value={answer}
              onChange={(e) => {
                setAnswer(e.currentTarget.value);
              }}
            />
          )}
          <div className="dialog-actions">
            <Button type="submit" variant="primary" disabled={answer === ''}>
              {t('login.submit')}
            </Button>
          </div>
        </form>
      );
  }
}

/** A sign-in in progress and its dialog: the steps Core reports on `core/login` for `provider`
 * (a model provider, T29, or an MCP server `mcp:<name>`, T36). `start` runs the sign-in. */
export function useSignInDialog(onChanged: () => void): {
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
    [onChanged],
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
  const outcome = view?.outcome;
  // Steps arrive after the dialog opened: each one takes the focus (its main action, or the
  // title while there is none), so the keyboard and Escape keep working inside the dialog.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const stepKey = view === undefined ? '' : JSON.stringify([view.step ?? null, outcome ?? null]);
  useEffect(() => {
    const dialog = titleRef.current?.closest('[role="dialog"]');
    if (dialog === null || dialog === undefined) return;
    const target = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? titleRef.current;
    target?.focus();
  }, [stepKey]);
  const dialog =
    view === undefined ? null : (
      <Dialog labelledBy={titleId} onCancel={cancel} testId="login-dialog">
        <h2 id={titleId} className="dialog-title" ref={titleRef} tabIndex={-1}>
          {t('login.title', { name: view.provider.name })}
        </h2>
        {outcome === undefined ? (
          <>
            <StepView
              key={JSON.stringify(view.step ?? null)}
              view={view}
              onAnswer={(value) => {
                if (view.loginId !== undefined) void window.piarc.answerLogin(view.loginId, value);
              }}
            />
            {view.note === undefined ? null : (
              <p className="muted small" role="status" data-testid="login-note">
                {view.note}
              </p>
            )}
            <div className="dialog-actions">
              <Button
                size="small"
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
              className={outcome.state === 'failed' ? 'error-text' : ''}
              data-testid="login-outcome"
              data-state={outcome.state}
            >
              {outcome.state === 'succeeded'
                ? t('login.succeeded', { name: view.provider.name })
                : outcome.state === 'cancelled'
                  ? t('login.cancelled')
                  : t('login.failed', { message: outcome.message ?? '' })}
            </p>
            <div className="dialog-actions">
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

/** The sign-in providers and the dialog of the sign-in in progress. */
export function SignInSection({
  providers,
  busy,
  onChanged,
}: {
  readonly providers: readonly LoginProvider[];
  readonly busy: boolean;
  /** The provider settings changed (signed in or out): reload them. */
  readonly onChanged: () => void;
}) {
  const t = useT();
  const signIn = useSignInDialog(onChanged);
  const { open } = signIn;
  const [failure, setFailure] = useState('');
  const shown = failure === '' ? signIn.failure : failure;
  return (
    <section className="settings-subsection" data-testid="sign-in-section">
      <h2 className="settings-heading">{t('providers.signIn.title')}</h2>
      <p className="muted small">{t('providers.signIn.hint')}</p>
      {providers.length === 0 ? (
        <p className="muted">{t('providers.signIn.none')}</p>
      ) : (
        <ul className="provider-list">
          {providers.map((p) => (
            <li key={p.id} data-testid={`login-provider-${p.id}`}>
              <div>
                <strong>{p.name}</strong>
                <div className="muted small">
                  {p.label}
                  {p.subscription ? ` · ${t('providers.signIn.subscription')}` : ''}
                  {p.signedIn ? ` · ${t('providers.signIn.signedIn')}` : ''}
                </div>
              </div>
              {p.signedIn ? (
                <Button
                  size="small"
                  data-testid={`logout-${p.id}`}
                  disabled={busy || open}
                  onClick={() => {
                    window.piarc.logoutProvider(p.id).then(
                      (done) => {
                        // Core answers the sign-out itself; read the settings again.
                        if (done !== null) onChanged();
                      },
                      (e: unknown) => {
                        setFailure(reason(e));
                      },
                    );
                  }}
                >
                  {t('providers.logout')}
                </Button>
              ) : (
                <Button
                  size="small"
                  data-testid={`login-${p.id}`}
                  disabled={busy || open}
                  onClick={() => {
                    setFailure('');
                    signIn.start(p, () => window.piarc.startLogin(p.id));
                  }}
                >
                  {t('providers.signIn.button')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {shown === '' ? null : (
        <p className="error-text" role="alert">
          {t('providers.failed', { reason: shown })}
        </p>
      )}
      {signIn.dialog}
    </section>
  );
}
